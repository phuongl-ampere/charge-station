# Task 6 Report: Direct Core IoT Runtime

## Outcome

The Charge Station runtime no longer contains or starts the IoT mock. Compose
runs the API, web application, PostgreSQL, and the Core MQTT device simulator.
The API uses the isolated Core public endpoint through
`host.docker.internal:18090`; the simulator uses
`host.docker.internal:18893`.

`CommandDispatcherService` has no legacy fallback: every persisted start or
stop is sent through `CoreIotClient.setRelay`, and readiness probes Core
directly. `ST01` is refreshed to `IOT_CORE_DEVICE_ID` on every seed run.

## TDD Evidence

1. Red Compose assertion:

   ```sh
   pnpm exec vitest run scripts/core-iot-local-e2e.spec.ts
   ```

   Before the Compose change it failed because `docker-compose.yml` contained
   `iot-service:` and mock-only environment entries.

2. Red direct-dispatch test:

   ```sh
   pnpm --filter @charge-station/api exec vitest run src/iot/command-dispatcher.service.spec.ts
   ```

   After the tests were changed to require `CoreIotClient.setRelay`, the old
   implementation failed with `this.iotServiceClient.start is not a function`.

3. Green focused verification:

   ```text
   scripts/core-iot-local-e2e.spec.ts: 3/3 passed
   command-dispatcher.service.spec.ts: 19/19 passed
   seed.e2e-spec.ts: 3/3 passed
   ```

The new focused checks assert no mock Compose service, reject non-isolated
provisioning URLs, verify a mode-0700 temporary secret directory with a
mode-0600 env file, and verify existing `ST01` device mapping refresh.

## Removed Runtime Surface

- Deleted `apps/iot-service/` in full.
- Deleted the legacy API IoT client and its tests.
- Deleted the service-token device-event controller and its tests.
- Deleted the in-process mock charge-lifecycle fixture.
- Removed the mock service, event storage volume, mock environment values, and
  service token from Compose.
- Removed mock build inputs from `Dockerfile` and the workspace lock importer.
- Replaced legacy dispatcher/charging PostgreSQL test doubles with Core client
  doubles.

No active source, config, or user-facing documentation retains a legacy client,
mock runtime configuration, service token, mock URL, or event-journal runtime
semantics. The static Compose test intentionally contains negative string
assertions for the removed names.

## Provisioning and Secret Boundary

`scripts/core-iot-local-e2e.ts` uses only the isolated Core management and
public HTTP APIs. It reuses `tenant1`, `user-a`, and `IOT_CORE_DEVICE_ID`, and
creates a missing user or device only through those APIs. Management session
cookies remain in memory. The device MQTT token is written only to a freshly
created `0700` temporary directory, supplied to Compose with `--env-file`, and
removed immediately after Compose starts.

Compose requires `IOT_CORE_ACCESS_TOKEN`, `IOT_CORE_DEVICE_ID`, and the device
token at runtime. It embeds no Core credential. `.env.example` has only clear
placeholders, not credential material. The harness and its errors do not print
tokens, passwords, or cookies.

## Verification Evidence

- `docker compose config --quiet` passed using non-secret synthetic values.
- `pnpm exec vitest run scripts/core-iot-local-e2e.spec.ts` passed: 3 tests.
- `pnpm --filter @charge-station/api test` passed: 27 files, 136 tests.
- `pnpm --filter @charge-station/api test:e2e` passed: 5 files, 20 tests.
- `pnpm --filter @charge-station/api lint` passed.
- `pnpm --filter @charge-station/web test` passed: 6 files, 30 tests.
- `pnpm --filter @charge-station/web lint` passed.
- `pnpm build` passed for contracts, API, and web.
- `git diff --check` passed.
- Unauthenticated probes confirmed the isolated Core public and management
  listeners are reachable; both returned HTTP 404 at `/health`, as expected
  for those listeners without a health route. No credentials were sent or
  logged.

## Real-Flow Harness

With externally supplied Core credentials, run:

```sh
pnpm tsx scripts/core-iot-local-e2e.ts
```

It provisions/reuses through APIs, waits for telemetry, creates and completes
a local order, waits for `CHARGING` and relay-on telemetry, stops the session,
waits for `CANCELLED`, and verifies relay-off telemetry. It does not call
`docker compose down -v`.

## Self-review and Concern

The harness requires `IOT_CORE_ACCESS_TOKEN`, `IOT_CORE_DEVICE_ID`,
`CORE_TENANT_PASSWORD`, and `CORE_USER_PASSWORD` in its process environment.
Those credentials were not available in this execution environment, so the
credential-gated start/order/stop flow was deliberately not run. This avoids
inventing, searching for, printing, or persisting Core credentials. All static,
unit, integration-test, build, lint, Compose-schema, and unauthenticated Core
reachability checks above were run successfully.

## Review-Fix Follow-up

The harness now provisions a device when no configured ID is present or when a
configured ID is no longer found, and writes both the selected device ID and
the MQTT token to the private temporary Compose environment file. The Compose
child process deliberately removes any inherited device ID or token so that
those private values cannot be overridden by the invoking shell.

Telemetry confirmation is bounded polling rather than a one-shot observation.
Start requires a fresh sample for the created session with relay on and
nonzero current and power; stop requires relay off with the session cleared.
The harness also verifies the matching live telemetry returned by Charge
Station Admin before stopping. Core public and management HTTP requests reject
redirects.

Review-fix verification completed without exposing credentials:

- Harness regression suite: 9 tests passed, including fresh provisioning,
  private environment precedence, redirect rejection, delayed telemetry, and
  Admin telemetry validation.
- Workspace unit suite: 171 tests passed across API, web, and contracts.
- API E2E suite: 20 tests passed.
- Build, API/web type checks, formatting, and diff validation passed.
- Browser E2E suite: 8 tests passed using the active local web server with all
  API requests intercepted; no Compose service was started, stopped, or
  modified.

The credential-gated live Core flow remains unexecuted in this shell because
the required runtime credentials and access token are absent. No credential
values, cookies, device identifiers, or temporary-secret paths were recorded.

## Port-Isolation Follow-up

Compose now parameterizes its API, web, and PostgreSQL host ports while keeping
manual defaults at `4000`, `3100`, and `5432`. The API origin is used
consistently for web build input, browser runtime input, PayOS mock checkout,
PayOS return/cancel callbacks, and the harness API client. The web origin is
used for `FRONTEND_URL`.

The harness selects the isolated project
`charge-station-core-iot-e2e` with API `4100`, web `3110`, and PostgreSQL
`5433` by default. Validated host-port and project-name overrides are supported
without inheriting the active user stack's Compose project. The harness does
not stop or modify any existing Compose project.

Verification: the focused harness suite passed 11 tests, the workspace unit
suite passed 171 tests, formatting and diff validation passed, and Compose
schema rendering passed with both default manual ports and synthetic overridden
API, web, PostgreSQL, and origin values. No OAuth or credential-gated live
operation was attempted in this follow-up.
