import unittest

from src.device_state import ChargeDeviceState
from src.main import handle_rpc


class ChargeDeviceStateTests(unittest.TestCase):
    def test_start_relay_owns_duration_and_accumulates_energy(self) -> None:
        state = ChargeDeviceState(voltage_v=230.0, current_a=10.0)

        state.set_relay(
            enabled=True,
            duration_seconds=2,
            session_id="session-1",
            now=100.0,
        )

        sample = state.sample(now=101.0)

        self.assertTrue(sample["relay_state"])
        self.assertEqual(sample["remaining_seconds"], 1)
        self.assertEqual(sample["power_w"], 2300.0)
        self.assertGreater(sample["energy_kwh"], 0)

    def test_expiry_turns_relay_off_locally(self) -> None:
        state = ChargeDeviceState()

        state.set_relay(
            enabled=True,
            duration_seconds=1,
            session_id="session-1",
            now=100.0,
        )

        sample = state.sample(now=101.1)

        self.assertFalse(sample["relay_state"])
        self.assertEqual(sample["session_id"], "session-1")
        self.assertEqual(sample["last_stop_reason"], "TIMER_EXPIRED")

    def test_start_rejects_non_positive_duration(self) -> None:
        state = ChargeDeviceState()

        with self.assertRaisesRegex(ValueError, "positive integer"):
            state.set_relay(
                enabled=True,
                duration_seconds=0,
                session_id="session-1",
                now=100.0,
            )

    def test_two_way_set_relay_returns_actual_snapshot(self) -> None:
        response = handle_rpc(
            {
                "id": "command-1",
                "method": "setRelay",
                "mode": "two_way",
                "params": {
                    "relayId": "relay-1",
                    "enabled": True,
                    "durationSeconds": 60,
                    "sessionId": "session-1",
                },
            },
            ChargeDeviceState(),
            now=100.0,
        )

        self.assertTrue(response["ok"])
        self.assertTrue(response["result"]["enabled"])
        self.assertEqual(response["result"]["remainingSeconds"], 60)

    def test_invalid_two_way_command_returns_not_ok(self) -> None:
        response = handle_rpc(
            {"id": "command-1", "method": "notSetRelay", "mode": "two_way", "params": {}},
            ChargeDeviceState(),
            now=100.0,
        )

        self.assertFalse(response["ok"])

    def test_unknown_relay_id_is_rejected_without_changing_state(self) -> None:
        state = ChargeDeviceState()

        response = handle_rpc(
            {
                "id": "command-1",
                "method": "setRelay",
                "mode": "two_way",
                "params": {
                    "relayId": "relay-unknown",
                    "enabled": True,
                    "durationSeconds": 60,
                    "sessionId": "session-1",
                },
            },
            state,
            now=100.0,
        )

        self.assertFalse(response["ok"])
        self.assertFalse(state.sample(now=100.0)["relay_state"])
