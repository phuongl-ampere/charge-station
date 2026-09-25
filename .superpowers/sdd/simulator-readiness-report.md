# Simulator RPC readiness report

## Scope

The simulator previously started publishing telemetry immediately after connecting, but did
not expose whether its QoS-1 RPC-request subscription had been acknowledged. This change
adds subscription-gated readiness and safe MQTT lifecycle logs without changing relay or
meter behavior.

`RpcSubscriptionReadiness` writes `/tmp/core-iot-device-simulator.ready` only when the
pending `v1/devices/me/rpc/request/+` QoS-1 subscription receives a single QoS-1 SUBACK.
It removes the file on reconnect, disconnect, a failed subscription request, or a rejected
or mismatched SUBACK. Compose uses that file for the simulator healthcheck, and the API now
waits for the simulator to be healthy as well as Postgres.

The simulator emits no MQTT payloads or credentials. Its new logs identify only connection
outcome, subscription request/acceptance/rejection, command ID receipt, and response queue
or publish result.

## TDD evidence

### Red

`python3 -m unittest tests/test_rpc_readiness.py -v` initially failed with
`ModuleNotFoundError: No module named 'src.rpc_readiness'`. This established the missing
readiness implementation. The first attempt used `python`, which is not installed on the
host; subsequent simulator tests use `python3`.

A later focused test failed as intended because the MQTT success helper did not initially
accept Paho-style reason-code objects exposing a numeric `value`. The helper now handles
those values without treating booleans as successful MQTT results.

### Green

After adding the helper and state, the focused readiness suite passed:

```text
Ran 3 tests in 0.002s
OK
```

The final complete simulator suite passed:

```text
Ran 11 tests in 0.003s
OK
```

Coverage includes accepted QoS-1 SUBACK readiness-file creation, rejected/mismatched
SUBACKs, an incorrect request filter, and clearing prior readiness on a new connection.

## Additional verification

- `python3 -m py_compile src/main.py src/rpc_readiness.py src/device_state.py` exited 0.
- `git diff --check` exited 0.
- `docker compose config -q` exited 0 with non-secret validation placeholders for required
  Core variables.
- `docker compose build core-iot-device-simulator` exited 0. Docker reported only its
  environment-level buildx-plugin warning and successfully built/tagged the image.

## Runtime observation

No fresh live Core E2E attempt was started for this task, per instruction. Consequently the
new observability has not revealed an additional runtime bug, and this report makes no new
claim about the prior command-expiration cause. The next controller-run E2E session can use
the safe simulator logs and Compose health state to distinguish a broker subscription issue
from a later RPC delivery/response problem.
