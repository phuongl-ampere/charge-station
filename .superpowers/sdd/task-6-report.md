# Task 6 Report: IoT Command Dispatch and Device Events

## Outcome

Task 6 dispatches durable persisted `START_CHARGING` commands after the PayOS
transaction commits and consumes authenticated device events at
`POST /internal/device-events`.

The implementation is scoped to `apps/charge-station-api/src/iot`, the
necessary payment/module wiring, the persisted command status enum, and
focused tests.

## Implemented Behavior

- `PaymentsService.handleWebhook` persists the payment, session, and command in
  one transaction. It persists immutable `stationCode`, `connectorCode`,
  `sessionId`, `durationSeconds`, `expiresAt`, and `configVersion` values in
  the command payload, then invokes the dispatcher only after the transaction
  resolves.
- `CommandDispatcherService` sends the existing `commandId` and stored start
  payload to `IOT_SERVICE_URL`. It never generates a replacement command ID,
  duration, or expiry.
- Commands become `SENT` only after the local IoT service returns a successful,
  matching accepted response. Transport failures retry after 1, 5, and 20
  seconds, recording `retryCount`; an exhausted or rejected command is marked
  `FAILED`.
- Startup scans durable `PENDING` commands so a process stop between payment
  commit and immediate dispatch does not lose the command.
- `IotServiceClient` requires both `IOT_SERVICE_URL` and `SERVICE_TOKEN`,
  accepts only localhost, loopback, or the local `iot-service` hostname, and
  uses `redirect: 'error'`.
- The device event controller requires `X-Service-Token`.
- The event service validates the shared `DeviceEvent` contract, serializes
  work per session in-process, locks the charging-session row in the database,
  persists each accepted event, and treats a previously persisted `eventId` as
  an idempotent no-op.
- `COMMAND_ACCEPTED` transitions `PENDING` to `STARTING`; only `RUNNING`
  transitions `STARTING` to `CHARGING` and records `startedAt` and relay-on
  state. Repeated `RUNNING` events do not repeat the transition.
- `HEARTBEAT` durably records `estimatedRemainingSeconds` and
  `lastDeviceEventAt` in its persisted event payload. `DEVICE_OFFLINE` retains
  the session and durably records an operational warning.
- `STOPPED` sets `COMPLETED` only for `TIMER_EXPIRED`, otherwise `CANCELLED`,
  and releases the connector only in that confirmed stop transition.
  `COMMAND_FAILED` transitions a pending/starting session to `START_FAILED`
  without releasing the connector.

## Files Changed

- `apps/charge-station-api/src/iot/iot.module.ts`
- `apps/charge-station-api/src/iot/iot-service.client.ts`
- `apps/charge-station-api/src/iot/command-dispatcher.service.ts`
- `apps/charge-station-api/src/iot/device-events.controller.ts`
- `apps/charge-station-api/src/iot/device-events.service.ts`
- IoT service, dispatcher, client, and guard unit tests under
  `apps/charge-station-api/src/iot/`
- `apps/charge-station-api/src/payments/payments.service.ts`
- `apps/charge-station-api/src/payments/payments.module.ts`
- `apps/charge-station-api/src/payments/payments.service.spec.ts`
- `apps/charge-station-api/src/database/data-source.ts`

## TDD Evidence

1. Red: before production IoT services existed:

   ```text
   pnpm --filter @charge-station/api test -- device-events.service.spec.ts command-dispatcher.service.spec.ts
   ```

   Result: failed with two expected module-resolution failures for
   `device-events.service.js` and `command-dispatcher.service.js`.

2. Green: after implementing the event consumer and dispatcher:

   ```text
   pnpm --filter @charge-station/api test -- device-events.service.spec.ts command-dispatcher.service.spec.ts
   ```

   Result: 2 test files and 5 tests passed.

3. Red: the payment test was extended to require dispatch after transaction
   completion:

   ```text
   pnpm --filter @charge-station/api test -- payments.service.spec.ts
   ```

   Result: failed as expected because `commandDispatcher.dispatch` had zero
   calls.

4. Green: after the post-commit dispatcher wiring:

   ```text
   pnpm --filter @charge-station/api test -- payments.service.spec.ts device-events.service.spec.ts command-dispatcher.service.spec.ts
   ```

   Result: 3 test files and 7 tests passed.

5. Additional focused coverage verifies local-only URL enforcement, required
   service tokens, and guard behavior using Vitest mocks only. No test calls an
   external service.

## Final Verification

- `pnpm --filter @charge-station/api test`
  - Passed: 9 files, 21 tests.
- `pnpm --filter @charge-station/api test:e2e`
  - Passed: 4 files, 13 tests.
- `pnpm --filter @charge-station/iot-service test`
  - Passed: 2 files, 12 tests.
- `pnpm --filter @charge-station/api lint`
  - Passed.
- `pnpm --filter @charge-station/api build`
  - Passed.
- `pnpm --filter @charge-station/contracts build`
  - Passed.
- `pnpm exec prettier --check ...`
  - Passed for all changed API files.
- `git diff --check`
  - Passed with no whitespace errors.

## Local-Only Test Boundary

The new client tests stub `fetch` in-process. The service-token tests invoke
the Nest guard with an in-memory request context. Existing API e2e tests use
their local pg-mem setup. No production or test request targets an external
host.
