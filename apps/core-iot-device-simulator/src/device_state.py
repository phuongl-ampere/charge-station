from __future__ import annotations

import math


class ChargeDeviceState:
    def __init__(self, *, voltage_v: float = 230.4, current_a: float = 10.2) -> None:
        self.voltage_v = voltage_v
        self.current_a = current_a
        self.relay_state = False
        self.session_id: str | None = None
        self.expires_at: float | None = None
        self.last_stop_reason: str | None = None
        self.energy_kwh = 0.0
        self._last_advanced_at: float | None = None

    def set_relay(
        self,
        *,
        enabled: bool,
        duration_seconds: int | None,
        session_id: str | None,
        now: float,
    ) -> dict[str, object]:
        if enabled:
            self._validate_duration(duration_seconds)

        self._advance(now)
        self.relay_state = enabled
        self.session_id = session_id if enabled else None
        self.expires_at = now + duration_seconds if enabled else None
        self.last_stop_reason = None if enabled else "USER_REQUESTED"
        return self.sample(now=now)

    def sample(self, *, now: float) -> dict[str, object]:
        self._advance(now)
        power_w = self.voltage_v * self.current_a if self.relay_state else 0.0
        current_a = self.current_a if self.relay_state else 0.0
        remaining_seconds = (
            math.ceil(self.expires_at - now)
            if self.expires_at is not None and self.relay_state
            else 0
        )
        return {
            "relay_state": self.relay_state,
            "session_id": self.session_id,
            "remaining_seconds": remaining_seconds,
            "last_stop_reason": self.last_stop_reason,
            "voltage_v": self.voltage_v,
            "current_a": current_a,
            "power_w": power_w,
            "energy_kwh": self.energy_kwh,
        }

    def _advance(self, now: float) -> None:
        if self._last_advanced_at is None:
            self._last_advanced_at = now
            return
        if now < self._last_advanced_at:
            raise ValueError("time cannot move backwards")

        on_until = self.expires_at if self.expires_at is not None else now
        energized_until = min(now, on_until) if self.relay_state else self._last_advanced_at
        elapsed_seconds = max(0.0, energized_until - self._last_advanced_at)
        self.energy_kwh += (self.voltage_v * self.current_a * elapsed_seconds) / 3_600_000
        self._last_advanced_at = now

        if self.relay_state and self.expires_at is not None and now >= self.expires_at:
            self.relay_state = False
            self.session_id = None
            self.last_stop_reason = "TIMER_EXPIRED"
            self.expires_at = None

    @staticmethod
    def _validate_duration(duration_seconds: int | None) -> None:
        if (
            isinstance(duration_seconds, bool)
            or not isinstance(duration_seconds, int)
            or duration_seconds <= 0
        ):
            raise ValueError("duration_seconds must be a positive integer")
