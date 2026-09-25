from __future__ import annotations

import json
import logging
import os
import threading
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .device_state import ChargeDeviceState
from .rpc_readiness import (
    RPC_REQUEST_TOPIC,
    RPC_REQUEST_QOS,
    RpcSubscriptionReadiness,
    telemetry_publish_is_allowed,
)


RPC_RESPONSE_TOPIC = "v1/devices/me/rpc/response/{}"
TELEMETRY_TOPIC = "v1/devices/me/telemetry"
DEVICE_TOKEN_USERNAME = "iotd_device_token"
RELAY_ID = "relay-1"
logger = logging.getLogger(__name__)


def handle_rpc(
    request: Mapping[str, Any], state: ChargeDeviceState, *, now: float
) -> dict[str, object]:
    if request.get("method") != "setRelay" or request.get("mode") != "two_way":
        return {"ok": False, "error": "unsupported two-way command"}

    params = request.get("params")
    if not isinstance(params, Mapping):
        return {"ok": False, "error": "params must be an object"}

    relay_id = params.get("relayId")
    enabled = params.get("enabled")
    if relay_id != RELAY_ID or not isinstance(enabled, bool):
        return {"ok": False, "error": "invalid relay command"}

    duration_seconds = params.get("durationSeconds")
    session_id = params.get("sessionId")
    if session_id is not None and not isinstance(session_id, str):
        return {"ok": False, "error": "invalid relay command"}

    try:
        sample = state.set_relay(
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
            "enabled": sample["relay_state"],
            "remainingSeconds": sample["remaining_seconds"],
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


def configure_mqtt_callbacks(
    client: Any,
    readiness: RpcSubscriptionReadiness,
    state: ChargeDeviceState,
    state_lock: Any | None = None,
) -> None:
    state_lock = state_lock or threading.Lock()
    response_publish_command_ids: dict[int, str] = {}

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
        command_id = response_publish_command_ids.pop(mid, None)
        if command_id is None:
            return
        if _mqtt_operation_succeeded(reason_code):
            logger.info("mqtt_rpc_response_published command_id=%s", command_id)
        else:
            logger.error(
                "mqtt_rpc_response_publish_failed command_id=%s reason=%s",
                command_id,
                reason_code,
            )

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

        publish_info = client.publish(
            RPC_RESPONSE_TOPIC.format(command_id),
            json.dumps(response, separators=(",", ":")),
            qos=1,
        )
        if _mqtt_operation_succeeded(publish_info.rc):
            response_publish_command_ids[publish_info.mid] = command_id
            logger.info("mqtt_rpc_response_queued command_id=%s", command_id)
        else:
            logger.error(
                "mqtt_rpc_response_queue_failed command_id=%s result=%s",
                command_id,
                publish_info.rc,
            )

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
