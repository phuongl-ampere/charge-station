# Task 9 Report

## Scope Delivered

- Added a full payment-to-charging lifecycle E2E test at `apps/charge-station-api/test/charge-lifecycle.e2e-spec.ts`.
- Added local Docker Compose services for PostgreSQL, Charge Station API, IoT Service, and web.
- Added API and IoT `GET /health` endpoints.
- Added local browser-to-API CORS configuration for `FRONTEND_URL`.
- Added local runtime, environment, mock webhook, and PayOS production callback documentation.

## TDD Evidence

### RED

Command:

```sh
pnpm --filter @charge-station/api test:e2e -- test/charge-lifecycle.e2e-spec.ts
```

Result: exit 1. The new composed lifecycle test reached its first missing behavior and failed with:

```text
expected 200 "OK", got 404 "Not Found"
```

The failing request was API `GET /health`.

After health endpoints were added, the browser preflight assertion was added and run red:

```text
expected "access-control-allow-origin" header field
```

This demonstrated the missing CORS configuration for the client-side web application before `configureHttpApp()` was introduced.

### GREEN

Command:

```sh
pnpm --filter @charge-station/api test:e2e
```

Result: exit 0, 6 test files and 15 tests passed. The lifecycle test verifies:

- connector discovery and mock PayOS payment-link creation;
- no device command or device timer before a signed webhook;
- signed webhook using `PAYOS_CHECKSUM_KEY`;
- one command and one observed mock-device start timer after duplicate webhook delivery;
- `RUNNING` drives API session state to `CHARGING`;
- frontend-visible `timerAuthority` is `DEVICE`;
- device-owned early completion despite the API's one-hour expected end;
- one `STOPPED` device event completes the session and releases the connector.

The test uses only loopback HTTP, a recorded mock PayOS adapter, and a one-second test-only mock device state adapter. No external payment or device service is called.

## Local Runtime Evidence

Build and start command:

```sh
docker compose up -d --build --wait
```

Result: exit 0. PostgreSQL, Charge Station API, IoT Service, and web all reached `healthy`.

Verified after startup:

```text
OPTIONS /public/connectors/ST01-C01
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: http://localhost:3000
```

The seeded connector endpoint returned `ST01-C01` with 5,000 VND/hour pricing. API health returned `{"status":"ok"}` and the web scan route returned HTTP 200.

The Docker Compose CLI warned that buildx is not installed and used Docker's classic builder. The image build and service startup still succeeded.

## Full Verification

The requested sequence was run after the final lifecycle assertion change:

```sh
docker compose up -d --wait
pnpm test
pnpm build
pnpm --filter @charge-station/api test:e2e
pnpm --filter @charge-station/web playwright test
docker compose down
```

Results:

- `docker compose up -d --wait`: exit 0; all four services healthy.
- `pnpm test`: exit 0; 78 unit tests passed across contracts, web, IoT, and API.
- `pnpm build`: exit 0; contracts, web, IoT, and API builds passed.
- API E2E: exit 0; 15 tests passed.
- Playwright: exit 0; desktop and mobile checkout tests passed.
- `docker compose down`: exit 0; containers and network removed.

Expected non-failing warnings remain from existing test infrastructure: Vite's CJS API deprecation, mocked IoT delivery failures in isolated IoT unit tests, and Playwright's `NO_COLOR`/localStorage process warnings.
