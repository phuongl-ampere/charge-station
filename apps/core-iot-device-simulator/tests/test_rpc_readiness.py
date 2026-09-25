import tempfile
import unittest
from pathlib import Path

from src.main import _mqtt_operation_succeeded
from src.rpc_readiness import RPC_REQUEST_TOPIC, RpcSubscriptionReadiness


class RpcSubscriptionReadinessTests(unittest.TestCase):
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
