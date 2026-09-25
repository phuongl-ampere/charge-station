from __future__ import annotations

import threading
from collections.abc import Sequence
from pathlib import Path
from typing import Any


RPC_REQUEST_TOPIC = "v1/devices/me/rpc/request/+"
RPC_REQUEST_QOS = 1


def is_exact_qos_one_suback(granted_qos: Sequence[Any]) -> bool:
    """Return whether a single RPC request subscription was accepted at QoS 1."""
    return len(granted_qos) == 1 and _reason_code_value(granted_qos[0]) == RPC_REQUEST_QOS


def telemetry_publish_is_allowed(readiness: "RpcSubscriptionReadiness") -> bool:
    """Return whether telemetry may be sent without queueing during MQTT recovery."""
    return readiness.is_ready


class RpcSubscriptionReadiness:
    """Tracks whether the exact RPC request subscription is acknowledged by the broker."""

    def __init__(self, ready_path: Path) -> None:
        self._ready_path = ready_path
        self._lock = threading.Lock()
        self._pending_mid: int | None = None
        self._is_ready = False
        self._clear_ready()

    @property
    def is_ready(self) -> bool:
        with self._lock:
            return self._is_ready

    def record_connection_attempt(self) -> None:
        with self._lock:
            self._pending_mid = None
            self._is_ready = False
            self._clear_ready()

    def record_subscription_request(self, *, mid: int, topic: str, qos: int) -> bool:
        with self._lock:
            self._is_ready = False
            self._clear_ready()
            if topic != RPC_REQUEST_TOPIC or qos != RPC_REQUEST_QOS:
                self._pending_mid = None
                return False

            self._pending_mid = mid
            return True

    def record_suback(self, *, mid: int, granted_qos: Sequence[Any]) -> bool:
        with self._lock:
            accepted = self._pending_mid == mid and is_exact_qos_one_suback(granted_qos)
            self._pending_mid = None
            self._is_ready = accepted
            if accepted:
                self._ready_path.parent.mkdir(parents=True, exist_ok=True)
                self._ready_path.touch()
            else:
                self._clear_ready()
            return accepted

    def _clear_ready(self) -> None:
        self._ready_path.unlink(missing_ok=True)


def _reason_code_value(reason_code: Any) -> int | None:
    if isinstance(reason_code, bool):
        return None
    if isinstance(reason_code, int):
        return reason_code

    value = getattr(reason_code, "value", None)
    return value if isinstance(value, int) and not isinstance(value, bool) else None
