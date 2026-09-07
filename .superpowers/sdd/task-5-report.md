# Task 5 Report: Independent Mock IoT Service

## Outcome

Implemented and committed Task 5 on branch `feat/charge-station-mvp`.

- Commit: `73eb3bf` (`feat: add mock iot timer service`)
- Scope: `apps/iot-service` only
- Shared contracts: consumed through `@charge-station/contracts`

## Files Changed

- `apps/iot-service/package.json`
- `apps/iot-service/tsconfig.json`
- `apps/iot-service/vitest.config.ts`
- `apps/iot-service/vitest.e2e.config.ts`
- `apps/iot-service/src/main.ts`
- `apps/iot-service/src/app.module.ts`
- `apps/iot-service/src/commands/commands.controller.ts`
- `apps/iot-service/src/commands/commands.service.ts`
- `apps/iot-service/src/commands/commands.service.spec.ts`
- `apps/iot-service/src/commands/commands.e2e-spec.ts`
- `apps/iot-service/src/devices/device-state.service.ts`
- `apps/iot-service/src/events/charge-station-event.client.ts`
- `apps/iot-service/src/common/service-token.guard.ts`

## Implemented Behavior

- Added `POST /internal/commands/start` and `POST /internal/commands/stop`.
- Protected both routes with `X-Service-Token`.
- Added in-memory connector/session state and command deduplication.
- Added delayed `RUNNING`, periodic `HEARTBEAT`, and timer-expiry `STOPPED` events.
- Added stop handling that clears the start, heartbeat, and expiry timers.
- Added `MOCK_IOT_FAILURE_MODE` handling for `none`, `timeout`, `offline`, and `command_failed`.
- Added a local Charge Station event client using `CHARGE_STATION_API_URL` and `SERVICE_TOKEN`.
- Added response shape `{ commandId, accepted, deviceId, status }`.

## TDD Evidence

1. Added the focused timer test before production implementation:

   `pnpm --filter @charge-station/iot-service test -- commands.service.spec.ts`

   Result: failed as expected with exit status 1. Vitest loaded the test file and reported that `./commands.service` did not exist.

2. Implemented the service and reran the focused test:

   `pnpm --filter @charge-station/iot-service test -- commands.service.spec.ts`

   Result: passed, 1 test.

## Verification

- `pnpm install --offline`: passed, dependencies already available from the lockfile/store.
- `pnpm --filter @charge-station/iot-service test`: passed, 1 test.
- `pnpm --filter @charge-station/iot-service test:e2e -- commands.e2e-spec.ts`: passed, 3 tests.
- `pnpm --filter @charge-station/iot-service lint`: passed.
- `pnpm --filter @charge-station/iot-service build`: passed.
- `pnpm exec prettier --check apps/iot-service/package.json apps/iot-service/src apps/iot-service/tsconfig.json apps/iot-service/vitest.config.ts apps/iot-service/vitest.e2e.config.ts`: passed.
- `git diff --cached --check`: passed before commit.

## Concerns

- The e2e tests mock `ChargeStationEventClient`; they do not require or start a Charge Station API. The production client is configured for the local `CHARGE_STATION_API_URL` and does not call an external provider.
- `timeout`, `offline`, and `command_failed` are deterministic local simulation modes. Their event payloads are intended for MVP development and may need alignment with the later Charge Station event-consumer implementation.
- The existing workspace uses the repository's current Nest/Vitest setup, which emits a Vite CJS deprecation warning during tests; it does not affect test results.

## Review Fix Verification

- Fix commit: `5f6e771` (`fix: harden mock iot event delivery`)
- TDD red: `pnpm --filter @charge-station/iot-service test -- src/commands/commands.service.spec.ts src/events/charge-station-event.client.spec.ts` failed with 4 failing tests for rejected event delivery, non-local callback URLs, and missing service tokens.
- TDD green: the same focused command passed with 2 test files and 9 tests.
- `pnpm --filter @charge-station/iot-service test`: passed, 2 test files and 9 tests.
- `pnpm --filter @charge-station/iot-service test:e2e -- commands.e2e-spec.ts`: passed, 4 tests.
- `pnpm --filter @charge-station/iot-service lint`: passed.
- `pnpm --filter @charge-station/iot-service build`: passed.
- `pnpm exec prettier --check apps/iot-service/package.json apps/iot-service/src apps/iot-service/tsconfig.json apps/iot-service/vitest.config.ts apps/iot-service/vitest.e2e.config.ts`: passed.
- `git diff --cached --check`: passed before the fix commit.
