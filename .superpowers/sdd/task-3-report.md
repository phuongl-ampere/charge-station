# Task 3 Report

## Outcome

Task 3 is implemented in commit `ee6c109`:

`feat: add charge station persistence and auth`

The implementation is on branch `feat/charge-station-mvp`.

## Implemented

- Added NestJS API bootstrap and module wiring in `src/main.ts` and `src/app.module.ts`.
- Added TypeORM entities for `User`, `Station`, `Connector`, `Order`, `PaymentTransaction`, `ChargingSession`, `DeviceCommand`, and `DeviceEvent`, plus the pricing-plan support entity.
- Added the initial PostgreSQL migration with UUID primary keys, integer VND amounts, foreign keys, unique business identifiers, and the positive `payos_order_code_seq` bigint sequence.
- Added deterministic seed support for station `ST01` and available connector `ST01-C01`, with 60/120/180-minute durations and 5,000 VND hourly pricing.
- Added public `GET /public/connectors/:connectorCode`.
- Added bcrypt-backed `POST /auth/register` and `POST /auth/login`.
- Added JWT issuance with stable `sub` and `role` claims and an exported `JwtAuthGuard` for future protected endpoints.
- Added the API Vitest configurations and consumed the shared package through `@charge-station/contracts`.
- Added focused unit, auth, and local PostgreSQL-compatible HTTP integration tests.

## Files Changed

Implementation files committed:

- `apps/charge-station-api/package.json`
- `apps/charge-station-api/tsconfig.json`
- `apps/charge-station-api/vitest.config.ts`
- `apps/charge-station-api/vitest.e2e.config.ts`
- `apps/charge-station-api/src/main.ts`
- `apps/charge-station-api/src/app.module.ts`
- `apps/charge-station-api/src/database/data-source.ts`
- `apps/charge-station-api/src/database/migrations/001-initial-schema.ts`
- `apps/charge-station-api/src/database/seed.ts`
- `apps/charge-station-api/src/auth/auth.module.ts`
- `apps/charge-station-api/src/auth/auth.controller.ts`
- `apps/charge-station-api/src/auth/auth.service.ts`
- `apps/charge-station-api/src/auth/auth.service.spec.ts`
- `apps/charge-station-api/src/auth/jwt-auth.guard.ts`
- `apps/charge-station-api/src/connectors/connectors.module.ts`
- `apps/charge-station-api/src/connectors/connectors.controller.ts`
- `apps/charge-station-api/src/connectors/connectors.service.ts`
- `apps/charge-station-api/src/connectors/connectors.service.spec.ts`
- `apps/charge-station-api/src/connectors/connectors.e2e-spec.ts`
- `pnpm-lock.yaml`

## TDD Evidence

The required connector test was written before `ConnectorsService` existed.

Initial focused command:

`pnpm --filter @charge-station/api test -- connectors.service.spec.ts`

Result: failed because `./connectors.service` did not exist.

After implementation, the same command passed with `1` test passed and `0` failed.

An auth validation test was also added and first failed because blank credentials returned a token. After validation was implemented, the auth suite passed.

## Verification

Exact focused connector test:

`pnpm --filter @charge-station/api test -- connectors.service.spec.ts`

Result: passed, `1` test passed.

Exact connector integration test:

`pnpm --filter @charge-station/api test:e2e -- connectors.e2e-spec.ts`

Result: passed, `1` test passed. The test uses `pg-mem` with TypeORM and does not call external services.

Full API unit suite:

`pnpm --filter @charge-station/api test`

Result: passed, `2` test files and `3` tests passed.

API build:

`pnpm --filter @charge-station/api build`

Result: passed with exit code `0`.

Shared contracts build:

`pnpm --filter @charge-station/contracts build`

Result: passed with exit code `0`.

Migration verification:

The TypeORM migration was executed against a local `pg-mem` PostgreSQL-compatible database using `tsx`. It created `charging_sessions`, `connectors`, `device_commands`, `device_events`, `orders`, `payment_transactions`, `pricing_plans`, `stations`, and `users`, plus the TypeORM migrations table. The check passed after the migration class was given the required timestamp suffix.

Diff validation:

`git diff --check`

Result: passed with no whitespace errors.

## Concerns

- Unrelated `apps/iot-service` changes appeared in the worktree during dependency installation and remain unstaged. They were not reverted or included in commit `ee6c109`.
- Because pnpm resolves workspace manifests globally, `pnpm-lock.yaml` also contains importer/package metadata for those concurrent IoT changes even though the IoT source and package manifest were not staged in this commit. This should be reconciled when the IoT task is committed.
- A live PostgreSQL server was not required or used for tests; the integration and migration checks use `pg-mem`, as required by the local PostgreSQL-compatible test constraint.

## Task 3 Review Fix

The Important review findings were fixed in commit `a2054e2`:

- Added `apps/charge-station-api` package script `db:seed`, which builds the API and runs `node dist/database/seed.js`.
- Updated the seed entrypoint to run from either source TypeScript or compiled JavaScript, and to set a failing process exit code when seeding fails.
- Added a pg-mem lifecycle regression test that starts with an uninitialized TypeORM DataSource, runs migrations and seed twice, reopens the DataSource, verifies the migration row and seeded station/pricing/connector relationships, and confirms row counts remain idempotent.
- Removed the forgeable JWT fallback secret. `AuthService` now throws `JWT_SECRET must be set` when the environment variable is missing or blank. Tests set an explicit test-only secret.
- Wrapped malformed, invalid-shape, and expired JWT verification failures in Nest `UnauthorizedException`, with HTTP regression tests asserting status `401`.

### TDD Evidence

The new auth regressions were first run with:

`pnpm --filter @charge-station/api test -- auth.service.spec.ts`

Initial result: `5` tests ran, `3` failed. The missing-secret test did not throw, and malformed/expired token tests received raw `jsonwebtoken` errors.

The new e2e regressions were first run with:

`pnpm --filter @charge-station/api test:e2e -- jwt-auth.guard.e2e-spec.ts seed.e2e-spec.ts`

Initial result: `3` tests failed. The HTTP malformed-token regression returned `500` instead of `401`; the seed entrypoint helper was not implemented yet, and the initial migration fixture import was corrected before the production implementation was verified.

After implementation, the focused auth unit command passed:

`pnpm --filter @charge-station/api test -- auth.service.spec.ts`

Result: `1` test file and `5` tests passed, `0` failed.

The focused pg-mem and JWT HTTP command passed:

`pnpm --filter @charge-station/api test:e2e -- jwt-auth.guard.e2e-spec.ts seed.e2e-spec.ts`

Result: `3` test files and `5` tests passed, `0` failed.

### Final Verification

Full API unit suite:

`pnpm --filter @charge-station/api test`

Result: `2` test files and `6` tests passed, `0` failed.

Full API e2e suite:

`pnpm --filter @charge-station/api test:e2e`

Result: `3` test files and `5` tests passed, `0` failed.

API build:

`pnpm --filter @charge-station/api build`

Result: passed with exit code `0`.

Compiled seed module and JavaScript entrypoint check:

`node --input-type=module -e "const seed = await import('./apps/charge-station-api/dist/database/seed.js'); if (!seed.isSeedEntrypoint('/app/dist/database/seed.js')) process.exit(1); console.log('compiled seed module and .js entrypoint check passed')"`

Result: `compiled seed module and .js entrypoint check passed`.

Diff validation:

`git diff --check`

Result: passed with no whitespace errors.

The commit staged only `apps/charge-station-api` changes. Existing unrelated `apps/iot-service` changes in the shared worktree were left untouched and are not part of commit `a2054e2`.
