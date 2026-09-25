import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from src.device_state import ChargeDeviceState
from src.main import (
    RPC_RESPONSE_MAX_PUBLISH_ATTEMPTS,
    _mqtt_operation_succeeded,
    configure_mqtt_callbacks,
    start_mqtt_client,
)
from src.rpc_readiness import (
    RPC_REQUEST_TOPIC,
    RpcSubscriptionReadiness,
    telemetry_publish_is_allowed,
)


class RpcSubscriptionReadinessTests(unittest.TestCase):
    def test_telemetry_gate_tracks_exact_rpc_subscription_readiness(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            readiness = RpcSubscriptionReadiness(
                Path(temporary_directory) / "simulator-ready"
            )

            self.assertFalse(telemetry_publish_is_allowed(readiness))

            readiness.record_subscription_request(
                mid=7, topic=RPC_REQUEST_TOPIC, qos=1
            )
            readiness.record_suback(mid=7, granted_qos=[1])
            self.assertTrue(telemetry_publish_is_allowed(readiness))

            readiness.record_connection_attempt()
            self.assertFalse(telemetry_publish_is_allowed(readiness))

    def test_async_client_start_configures_retries_before_starting_the_loop(self) -> None:
        client = FakeMqttClient()

        start_mqtt_client(client, host="mqtt.example.test", port=1883)

        self.assertEqual(
            client.calls,
            [
                ("reconnect_delay_set", 1, 30),
                ("connect_async", "mqtt.example.test", 1883, 60),
                ("loop_start",),
            ],
        )

    def test_failed_subscribe_clears_readiness_in_the_connect_callback(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            ready_path = Path(temporary_directory) / "simulator-ready"
            readiness = RpcSubscriptionReadiness(ready_path)
            readiness.record_subscription_request(
                mid=1, topic=RPC_REQUEST_TOPIC, qos=1
            )
            readiness.record_suback(mid=1, granted_qos=[1])
            client = FakeMqttClient(subscribe_result=(1, 2))

            configure_mqtt_callbacks(client, readiness, ChargeDeviceState())
            with self.assertLogs("src.main", level="ERROR"):
                client.on_connect(client, None, None, 0, None)

            self.assertFalse(readiness.is_ready)
            self.assertFalse(ready_path.exists())

    def test_multiple_or_rejected_suback_grants_never_mark_healthy(self) -> None:
        for granted_qos in ([1, 1], [128]):
            with self.subTest(granted_qos=granted_qos), tempfile.TemporaryDirectory(
            ) as temporary_directory:
                ready_path = Path(temporary_directory) / "simulator-ready"
                readiness = RpcSubscriptionReadiness(ready_path)
                client = FakeMqttClient(subscribe_result=(0, 7))

                configure_mqtt_callbacks(client, readiness, ChargeDeviceState())
                client.on_connect(client, None, None, 0, None)
                with self.assertLogs("src.main", level="ERROR"):
                    client.on_subscribe(client, None, 7, granted_qos, None)

                self.assertFalse(readiness.is_ready)
                self.assertFalse(ready_path.exists())

    def test_mqtt_success_accepts_an_integer_like_reason_code_value(self) -> None:
        class ReasonCode:
            value = 0

        self.assertTrue(_mqtt_operation_succeeded(ReasonCode()))
        self.assertFalse(_mqtt_operation_succeeded(True))

    def test_marks_ready_only_after_the_pending_qos_one_filter_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            ready_path = Path(temporary_directory) / "simulator-ready"
            readiness = RpcSubscriptionReadiness(ready_path)

            readiness.record_subscription_request(
                mid=7, topic=RPC_REQUEST_TOPIC, qos=1
            )

            self.assertTrue(readiness.record_suback(mid=7, granted_qos=[1]))
            self.assertTrue(readiness.is_ready)
            self.assertTrue(ready_path.is_file())

    def test_rejected_or_mismatched_suback_never_marks_ready(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            ready_path = Path(temporary_directory) / "simulator-ready"
            readiness = RpcSubscriptionReadiness(ready_path)

            readiness.record_subscription_request(
                mid=7, topic=RPC_REQUEST_TOPIC, qos=1
            )

            self.assertFalse(readiness.record_suback(mid=7, granted_qos=[0]))
            self.assertFalse(readiness.is_ready)
            self.assertFalse(ready_path.exists())

            self.assertFalse(readiness.record_suback(mid=8, granted_qos=[1]))
            self.assertFalse(readiness.is_ready)

    def test_a_different_request_filter_cannot_become_ready(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            ready_path = Path(temporary_directory) / "simulator-ready"
            readiness = RpcSubscriptionReadiness(ready_path)

            self.assertFalse(
                readiness.record_subscription_request(
                    mid=7, topic="v1/devices/me/rpc/request/relay-1", qos=1
                )
            )
            self.assertFalse(readiness.record_suback(mid=7, granted_qos=[1]))
            self.assertFalse(readiness.is_ready)
            self.assertFalse(ready_path.exists())

    def test_connection_reset_removes_prior_readiness(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            ready_path = Path(temporary_directory) / "simulator-ready"
            readiness = RpcSubscriptionReadiness(ready_path)
            readiness.record_subscription_request(
                mid=7, topic=RPC_REQUEST_TOPIC, qos=1
            )
            readiness.record_suback(mid=7, granted_qos=[1])

            readiness.record_connection_attempt()

            self.assertFalse(readiness.is_ready)
            self.assertFalse(ready_path.exists())


class RpcResponseDeliveryTests(unittest.TestCase):
    def test_defers_rpc_response_until_after_message_callback(self) -> None:
        client = ResponseFakeMqttClient()
        scheduled: list[tuple[float, object]] = []

        configure_mqtt_callbacks(
            client,
            StubRpcReadiness(ready=True),
            ChargeDeviceState(),
            response_scheduler=lambda delay, callback: scheduled.append((delay, callback)),
        )

        client.on_message(
            client,
            None,
            SimpleNamespace(
                topic="v1/devices/me/rpc/request/command-1",
                payload=(
                    b'{"method":"setRelay","mode":"two_way","params":'
                    b'{"relayId":"relay-1","enabled":false}}'
                ),
            ),
        )

        self.assertEqual(client.publishes, [])
        self.assertEqual(len(scheduled), 1)

        _, callback = scheduled.pop()
        callback()

        self.assertEqual(
            client.publishes,
            [
                (
                    "v1/devices/me/rpc/response/command-1",
                    '{"ok":true,"result":{"relayId":"relay-1","enabled":false,"remainingSeconds":0}}',
                    1,
                )
            ],
        )

    def test_retries_unacknowledged_rpc_response_until_broker_puback(self) -> None:
        client = ResponseFakeMqttClient()
        scheduled: list[tuple[float, object]] = []

        configure_mqtt_callbacks(
            client,
            StubRpcReadiness(ready=True),
            ChargeDeviceState(),
            response_scheduler=lambda delay, callback: scheduled.append((delay, callback)),
        )
        client.on_message(
            client,
            None,
            SimpleNamespace(
                topic="v1/devices/me/rpc/request/command-1",
                payload=(
                    b'{"method":"setRelay","mode":"two_way","params":'
                    b'{"relayId":"relay-1","enabled":false}}'
                ),
            ),
        )

        _, initial_attempt = scheduled.pop()
        initial_attempt()
        _, retry_attempt = scheduled.pop()
        retry_attempt()
        self.assertEqual(len(client.publishes), 2)

        client.on_publish(client, None, 2, 0, None)
        _, post_ack_attempt = scheduled.pop()
        post_ack_attempt()

        self.assertEqual(len(client.publishes), 2)

    def test_keeps_rpc_responses_out_of_paho_queue_until_rpc_is_ready(self) -> None:
        client = ResponseFakeMqttClient()
        scheduled: list[tuple[float, object]] = []

        configure_mqtt_callbacks(
            client,
            StubRpcReadiness(ready=False),
            ChargeDeviceState(),
            response_scheduler=lambda delay, callback: scheduled.append((delay, callback)),
        )
        client.on_message(client, None, relay_off_message())

        _, initial_attempt = scheduled.pop()
        initial_attempt()

        self.assertEqual(client.publishes, [])
        self.assertEqual(len(scheduled), 1)

    def test_bounds_unacknowledged_rpc_response_publish_attempts(self) -> None:
        client = ResponseFakeMqttClient()
        scheduled: list[tuple[float, object]] = []

        configure_mqtt_callbacks(
            client,
            StubRpcReadiness(ready=True),
            ChargeDeviceState(),
            response_scheduler=lambda delay, callback: scheduled.append((delay, callback)),
        )
        client.on_message(client, None, relay_off_message())

        for _ in range(RPC_RESPONSE_MAX_PUBLISH_ATTEMPTS):
            _, attempt = scheduled.pop()
            attempt()

        self.assertEqual(len(client.publishes), RPC_RESPONSE_MAX_PUBLISH_ATTEMPTS)

        _, post_limit_attempt = scheduled.pop()
        with self.assertLogs("src.main", level="ERROR"):
            post_limit_attempt()

        self.assertEqual(len(client.publishes), RPC_RESPONSE_MAX_PUBLISH_ATTEMPTS)

    def test_bounds_publish_attempts_when_paho_rejects_the_response_queue(self) -> None:
        client = ResponseFakeMqttClient(publish_rc=1)
        scheduled: list[tuple[float, object]] = []

        configure_mqtt_callbacks(
            client,
            StubRpcReadiness(ready=True),
            ChargeDeviceState(),
            response_scheduler=lambda delay, callback: scheduled.append((delay, callback)),
        )
        client.on_message(client, None, relay_off_message())

        with self.assertLogs("src.main", level="ERROR"):
            for _ in range(RPC_RESPONSE_MAX_PUBLISH_ATTEMPTS):
                _, attempt = scheduled.pop()
                attempt()

        self.assertEqual(len(client.publishes), RPC_RESPONSE_MAX_PUBLISH_ATTEMPTS)

        _, post_limit_attempt = scheduled.pop()
        with self.assertLogs("src.main", level="ERROR"):
            post_limit_attempt()

        self.assertEqual(len(client.publishes), RPC_RESPONSE_MAX_PUBLISH_ATTEMPTS)


class FakeMqttClient:
    def __init__(self, *, subscribe_result: tuple[int, int] = (0, 1)) -> None:
        self.subscribe_result = subscribe_result
        self.calls: list[tuple[object, ...]] = []

    def reconnect_delay_set(self, *, min_delay: int, max_delay: int) -> None:
        self.calls.append(("reconnect_delay_set", min_delay, max_delay))

    def connect_async(self, host: str, port: int, keepalive: int) -> None:
        self.calls.append(("connect_async", host, port, keepalive))

    def loop_start(self) -> None:
        self.calls.append(("loop_start",))

    def subscribe(self, _topic: str, *, qos: int) -> tuple[int, int]:
        self.calls.append(("subscribe", qos))
        return self.subscribe_result


class ResponseFakeMqttClient(FakeMqttClient):
    def __init__(self, *, publish_rc: int = 0) -> None:
        super().__init__()
        self.publish_rc = publish_rc
        self.publishes: list[tuple[str, str, int]] = []

    def publish(self, topic: str, payload: str, *, qos: int) -> SimpleNamespace:
        self.publishes.append((topic, payload, qos))
        return SimpleNamespace(rc=self.publish_rc, mid=len(self.publishes))


class StubRpcReadiness:
    def __init__(self, *, ready: bool) -> None:
        self.is_ready = ready


def relay_off_message() -> SimpleNamespace:
    return SimpleNamespace(
        topic="v1/devices/me/rpc/request/command-1",
        payload=(
            b'{"method":"setRelay","mode":"two_way","params":'
            b'{"relayId":"relay-1","enabled":false}}'
        ),
    )
