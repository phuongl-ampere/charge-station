from __future__ import annotations

import json
import logging
import os
import threading
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Callable

from .device_state import RELAY_IDS, ChargeDeviceState
from .rpc_readiness import (
    RPC_REQUEST_TOPIC,
    RPC_REQUEST_QOS,
    RpcSubscriptionReadiness,
    telemetry_publish_is_allowed,
)


RPC_RESPONSE_TOPIC = "v1/devices/me/rpc/response/{}"
TELEMETRY_TOPIC = "v1/devices/me/telemetry"
DEVICE_TOKEN_USERNAME = "iotd_device_token"
RPC_RESPONSE_INITIAL_DELAY_SECONDS = 0.1
RPC_RESPONSE_RETRY_DELAY_SECONDS = 1.0
RPC_RESPONSE_MAX_PUBLISH_ATTEMPTS = 3
logger = logging.getLogger(__name__)


def handle_rpc(
    request: Mapping[str, Any], state: ChargeDeviceState, *, now: float
) -> dict[str, object]:
    if request.get("mode") != "two_way":
        return {"ok": False, "error": "unsupported two-way command"}

    params = request.get("params")
    if not isinstance(params, Mapping):
        return {"ok": False, "error": "params must be an object"}

    if request.get("method") != "setRelay":
        return {"ok": False, "error": "unsupported two-way command"}

    relay_id = params.get("relayId")
    enabled = params.get("enabled")
    if relay_id not in RELAY_IDS or not isinstance(enabled, bool):
        return {"ok": False, "error": "invalid relay command"}

    duration_seconds = params.get("durationSeconds")
    session_id = params.get("sessionId")
    if session_id is not None and not isinstance(session_id, str):
        return {"ok": False, "error": "invalid relay command"}

    try:
        sample = state.set_relay(
            relay_id=relay_id,
            enabled=enabled,
            duration_seconds=duration_seconds if enabled else None,
            session_id=session_id,
            now=now,
        )
    except ValueError as error:
        return {"ok": False, "error": str(error)}

    return {
        "ok": True,
        "result": {
            "relayId": relay_id,
            "enabled": sample["relays"][relay_id]["enabled"],
            "remainingSeconds": sample["relays"][relay_id]["remaining_seconds"],
        },
    }


def _mqtt_operation_succeeded(result: Any) -> bool:
    if isinstance(result, bool):
        return False
    try:
        return int(result) == 0
    except (TypeError, ValueError):
        value = getattr(result, "value", None)
        return isinstance(value, int) and not isinstance(value, bool) and value == 0


def start_mqtt_client(client: Any, *, host: str, port: int) -> None:
    client.reconnect_delay_set(min_delay=1, max_delay=30)
    client.connect_async(host, port, keepalive=60)
    client.loop_start()


ResponseScheduler = Callable[[float, Callable[[], None]], None]
ResponsePublishAllowed = Callable[[], bool]


def schedule_response_attempt(delay_seconds: float, callback: Callable[[], None]) -> None:
    timer = threading.Timer(delay_seconds, callback)
    timer.daemon = True
    timer.start()


class RpcResponseDelivery:
    def __init__(
        self,
        client: Any,
        scheduler: ResponseScheduler,
        publish_allowed: ResponsePublishAllowed,
    ) -> None:
        self._client = client
        self._scheduler = scheduler
        self._publish_allowed = publish_allowed
        self._lock = threading.Lock()
        self._pending_payloads: dict[str, str] = {}
        self._publish_attempts: dict[str, int] = {}
        self._command_ids_by_mid: dict[int, str] = {}

    def queue(self, command_id: str, response: dict[str, object]) -> None:
        payload = json.dumps(response, separators=(",", ":"))
        with self._lock:
            if command_id in self._pending_payloads:
                return
            self._pending_payloads[command_id] = payload
            self._publish_attempts[command_id] = 0
        self._schedule_attempt(command_id, RPC_RESPONSE_INITIAL_DELAY_SECONDS)

    def record_publish(self, mid: int, reason_code: Any) -> None:
        with self._lock:
            command_id = self._command_ids_by_mid.pop(mid, None)
            if command_id is None:
                return
            if not _mqtt_operation_succeeded(reason_code):
                logger.error(
                    "mqtt_rpc_response_publish_failed command_id=%s reason=%s",
                    command_id,
                    reason_code,
                )
                return
            if self._pending_payloads.pop(command_id, None) is None:
                return
            self._publish_attempts.pop(command_id, None)
            self._command_ids_by_mid = {
                pending_mid: pending_command_id
                for pending_mid, pending_command_id in self._command_ids_by_mid.items()
                if pending_command_id != command_id
            }
        logger.info("mqtt_rpc_response_published command_id=%s", command_id)

    def _schedule_attempt(self, command_id: str, delay_seconds: float) -> None:
        self._scheduler(
            delay_seconds,
            lambda: self._publish_if_pending(command_id),
        )

    def _publish_if_pending(self, command_id: str) -> None:
        should_retry = False
        with self._lock:
            payload = self._pending_payloads.get(command_id)
            if payload is None:
                return
            if not self._publish_allowed():
                should_retry = True
            elif self._publish_attempts[command_id] >= RPC_RESPONSE_MAX_PUBLISH_ATTEMPTS:
                self._pending_payloads.pop(command_id, None)
                self._publish_attempts.pop(command_id, None)
                self._command_ids_by_mid = {
                    pending_mid: pending_command_id
                    for pending_mid, pending_command_id in self._command_ids_by_mid.items()
                    if pending_command_id != command_id
                }
                logger.error(
                    "mqtt_rpc_response_delivery_abandoned command_id=%s",
                    command_id,
                )
            else:
                self._command_ids_by_mid = {
                    pending_mid: pending_command_id
                    for pending_mid, pending_command_id in self._command_ids_by_mid.items()
                    if pending_command_id != command_id
                }
                publish_info = self._client.publish(
                    RPC_RESPONSE_TOPIC.format(command_id),
                    payload,
                    qos=1,
                )
                self._publish_attempts[command_id] += 1
                if _mqtt_operation_succeeded(publish_info.rc):
                    self._command_ids_by_mid[publish_info.mid] = command_id
                    logger.info("mqtt_rpc_response_queued command_id=%s", command_id)
                else:
                    logger.error(
                        "mqtt_rpc_response_queue_failed command_id=%s result=%s",
                        command_id,
                        publish_info.rc,
                    )
                should_retry = True
        if should_retry:
            self._schedule_attempt(command_id, RPC_RESPONSE_RETRY_DELAY_SECONDS)


def configure_mqtt_callbacks(
    client: Any,
    readiness: RpcSubscriptionReadiness,
    state: ChargeDeviceState,
    state_lock: Any | None = None,
    response_scheduler: ResponseScheduler | None = None,
) -> None:
    state_lock = state_lock or threading.Lock()
    response_delivery = RpcResponseDelivery(
        client,
        response_scheduler or schedule_response_attempt,
        lambda: telemetry_publish_is_allowed(readiness),
    )

    def on_connect(
        client: Any,
        _userdata: Any,
        _flags: Any,
        reason_code: Any,
        _properties: Any,
    ) -> None:
        readiness.record_connection_attempt()
        if not _mqtt_operation_succeeded(reason_code):
            logger.error("mqtt_connection_failed reason=%s", reason_code)
            return

        logger.info("mqtt_connection_established")
        result, mid = client.subscribe(RPC_REQUEST_TOPIC, qos=RPC_REQUEST_QOS)
        if not _mqtt_operation_succeeded(result):
            logger.error("mqtt_rpc_subscription_request_failed result=%s", result)
            return
        readiness.record_subscription_request(
            mid=mid, topic=RPC_REQUEST_TOPIC, qos=RPC_REQUEST_QOS
        )
        logger.info(
            "mqtt_rpc_subscription_requested topic=%s qos=%s",
            RPC_REQUEST_TOPIC,
            RPC_REQUEST_QOS,
        )

    def on_connect_fail(_client: Any, _userdata: Any) -> None:
        readiness.record_connection_attempt()
        logger.error("mqtt_connection_failed")

    def on_subscribe(
        _client: Any,
        _userdata: Any,
        mid: int,
        granted_qos: list[Any],
        _properties: Any,
    ) -> None:
        if readiness.record_suback(mid=mid, granted_qos=granted_qos):
            logger.info(
                "mqtt_rpc_subscription_accepted topic=%s qos=%s",
                RPC_REQUEST_TOPIC,
                RPC_REQUEST_QOS,
            )
        else:
            logger.error("mqtt_rpc_subscription_rejected mid=%s", mid)

    def on_disconnect(
        _client: Any,
        _userdata: Any,
        _disconnect_flags: Any,
        reason_code: Any,
        _properties: Any,
    ) -> None:
        readiness.record_connection_attempt()
        logger.warning("mqtt_connection_lost reason=%s", reason_code)

    def on_publish(
        _client: Any,
        _userdata: Any,
        mid: int,
        reason_code: Any,
        _properties: Any,
    ) -> None:
        response_delivery.record_publish(mid, reason_code)

    def on_message(client: Any, _userdata: Any, message: Any) -> None:
        command_id = message.topic.rsplit("/", 1)[-1]
        logger.info("mqtt_rpc_command_received command_id=%s", command_id)
        try:
            request = json.loads(message.payload.decode("utf-8"))
            if not isinstance(request, Mapping):
                raise ValueError("request must be an object")
            with state_lock:
                response = handle_rpc(request, state, now=time.monotonic())
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            response = {"ok": False, "error": str(error)}

        response_delivery.queue(command_id, response)

    client.on_connect = on_connect
    client.on_connect_fail = on_connect_fail
    client.on_subscribe = on_subscribe
    client.on_disconnect = on_disconnect
    client.on_publish = on_publish
    client.on_message = on_message


def run() -> None:
    import paho.mqtt.client as mqtt

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    host = os.environ["IOT_CORE_MQTT_HOST"]
    port = int(os.environ["IOT_CORE_MQTT_PORT"])
    device_token = os.environ["IOT_CORE_DEVICE_TOKEN"]
    telemetry_interval_seconds = float(
        os.environ["IOT_SIMULATOR_TELEMETRY_INTERVAL_SECONDS"]
    )
    if telemetry_interval_seconds <= 0:
        raise ValueError("IOT_SIMULATOR_TELEMETRY_INTERVAL_SECONDS must be positive")

    readiness = RpcSubscriptionReadiness(
        Path(
            os.environ.get(
                "IOT_SIMULATOR_READINESS_FILE", "/tmp/core-iot-device-simulator.ready"
            )
        )
    )
    state = ChargeDeviceState()
    state_lock = threading.Lock()
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    client.username_pw_set(DEVICE_TOKEN_USERNAME, device_token)
    configure_mqtt_callbacks(client, readiness, state, state_lock)
    start_mqtt_client(client, host=host, port=port)
    try:
        while True:
            with state_lock:
                telemetry = state.sample(now=time.monotonic())
            if telemetry_publish_is_allowed(readiness):
                client.publish(
                    TELEMETRY_TOPIC,
                    json.dumps(telemetry, separators=(",", ":")),
                    qos=1,
                )
            time.sleep(telemetry_interval_seconds)
    finally:
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    run()
