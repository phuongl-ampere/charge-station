from __future__ import annotations

import json
import os
import threading
import time
from collections.abc import Mapping
from typing import Any

from .device_state import ChargeDeviceState


RPC_REQUEST_TOPIC = "v1/devices/me/rpc/request/+"
RPC_RESPONSE_TOPIC = "v1/devices/me/rpc/response/{}"
TELEMETRY_TOPIC = "v1/devices/me/telemetry"
DEVICE_TOKEN_USERNAME = "iotd_device_token"


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
    if not isinstance(relay_id, str) or not relay_id or not isinstance(enabled, bool):
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


def run() -> None:
    import paho.mqtt.client as mqtt

    host = os.environ["IOT_CORE_MQTT_HOST"]
    port = int(os.environ["IOT_CORE_MQTT_PORT"])
    device_token = os.environ["IOT_CORE_DEVICE_TOKEN"]
    telemetry_interval_seconds = float(
        os.environ["IOT_SIMULATOR_TELEMETRY_INTERVAL_SECONDS"]
    )
    if telemetry_interval_seconds <= 0:
        raise ValueError("IOT_SIMULATOR_TELEMETRY_INTERVAL_SECONDS must be positive")

    state = ChargeDeviceState()
    state_lock = threading.Lock()
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    client.username_pw_set(DEVICE_TOKEN_USERNAME, device_token)

    def on_connect(client: Any, _userdata: Any, _flags: Any, reason_code: Any, _properties: Any) -> None:
        if reason_code == 0:
            client.subscribe(RPC_REQUEST_TOPIC, qos=1)

    def on_message(client: Any, _userdata: Any, message: Any) -> None:
        try:
            request = json.loads(message.payload.decode("utf-8"))
            if not isinstance(request, Mapping):
                raise ValueError("request must be an object")
            with state_lock:
                response = handle_rpc(request, state, now=time.monotonic())
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            response = {"ok": False, "error": str(error)}

        command_id = message.topic.rsplit("/", 1)[-1]
        client.publish(
            RPC_RESPONSE_TOPIC.format(command_id),
            json.dumps(response, separators=(",", ":")),
            qos=1,
        )

    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(host, port, keepalive=60)
    client.loop_start()
    try:
        while True:
            with state_lock:
                telemetry = state.sample(now=time.monotonic())
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
