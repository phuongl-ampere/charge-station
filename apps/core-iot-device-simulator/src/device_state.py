from __future__ import annotations

import math
from dataclasses import dataclass


RELAY_IDS = ("relay-1", "relay-2", "relay-3", "relay-4")


@dataclass
class RelayState:
    enabled: bool = False
    session_id: str | None = None
    expires_at: float | None = None
    last_stop_reason: str | None = None
    energy_kwh: float = 0.0
    last_advanced_at: float | None = None
    source: str = "OFF"


class ChargeDeviceState:
    def __init__(self, *, voltage_v: float = 230.4, current_a: float = 10.2) -> None:
        self.voltage_v = voltage_v
        self.current_a = current_a
        self._relays = {relay_id: RelayState() for relay_id in RELAY_IDS}

    def set_relay(
        self,
        *,
        enabled: bool,
        duration_seconds: int | None,
        session_id: str | None,
        now: float,
        relay_id: str = "relay-1",
    ) -> dict[str, object]:
        if relay_id not in self._relays:
            raise ValueError(f"unknown relay_id: {relay_id}")
        if enabled:
            self._validate_duration(duration_seconds)

        self._advance(now)
        relay = self._relays[relay_id]
        relay.enabled = enabled
        relay.session_id = session_id if enabled else None
        relay.expires_at = now + duration_seconds if enabled else None
        relay.last_stop_reason = None if enabled else "USER_REQUESTED"
        relay.source = "MANUAL" if enabled else "MANUAL_OFF"
        return self.sample(now=now)

    def sample(self, *, now: float) -> dict[str, object]:
        self._advance(now)
        relays = {
            relay_id: self._relay_sample(relay, now)
            for relay_id, relay in self._relays.items()
        }
        primary = relays["relay-1"]
        return {
            "relay_state": primary["relay_state"],
            "session_id": primary["session_id"],
            "remaining_seconds": primary["remaining_seconds"],
            "last_stop_reason": primary["last_stop_reason"],
            "voltage_v": primary["voltage_v"],
            "current_a": primary["current_a"],
            "power_w": primary["power_w"],
            "energy_kwh": primary["energy_kwh"],
            "relays": relays,
            "total_power_w": sum(
                float(relay["power_w"]) for relay in relays.values()
            ),
            "total_energy_kwh": sum(
                float(relay["energy_kwh"]) for relay in relays.values()
            ),
        }

    def _relay_sample(self, relay: RelayState, now: float) -> dict[str, object]:
        power_w = self.voltage_v * self.current_a if relay.enabled else 0.0
        current_a = self.current_a if relay.enabled else 0.0
        remaining_seconds = (
            math.ceil(relay.expires_at - now)
            if relay.expires_at is not None and relay.enabled
            else 0
        )
        return {
            "relay_state": relay.enabled,
            "enabled": relay.enabled,
            "session_id": relay.session_id,
            "remaining_seconds": remaining_seconds,
            "last_stop_reason": relay.last_stop_reason,
            "voltage_v": self.voltage_v,
            "current_a": current_a,
            "power_w": power_w,
            "energy_kwh": relay.energy_kwh,
            "source": relay.source,
        }

    def _advance(self, now: float) -> None:
        for relay in self._relays.values():
            self._advance_relay(relay, now)

    def _advance_relay(self, relay: RelayState, now: float) -> None:
        if relay.last_advanced_at is None:
            relay.last_advanced_at = now
            return
        if now < relay.last_advanced_at:
            raise ValueError("time cannot move backwards")

        on_until = relay.expires_at if relay.expires_at is not None else now
        energized_until = min(now, on_until) if relay.enabled else relay.last_advanced_at
        elapsed_seconds = max(0.0, energized_until - relay.last_advanced_at)
        relay.energy_kwh += (
            self.voltage_v * self.current_a * elapsed_seconds
        ) / 3_600_000
        relay.last_advanced_at = now

        if relay.enabled and relay.expires_at is not None and now >= relay.expires_at:
            relay.enabled = False
            relay.last_stop_reason = "TIMER_EXPIRED"
            relay.expires_at = None
            relay.source = "OFF"

    @staticmethod
    def _validate_duration(duration_seconds: int | None) -> None:
        if (
            isinstance(duration_seconds, bool)
            or not isinstance(duration_seconds, int)
            or duration_seconds <= 0
        ):
            raise ValueError("duration_seconds must be a positive integer")
