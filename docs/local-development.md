# Local Development

## Prerequisites

- Docker Desktop with Compose v2.
- Node.js 22 and pnpm 9 for host-side tests and builds.
- An already-running isolated Core at public `http://127.0.0.1:18090`,
  management `http://127.0.0.1:18091`, and MQTT `127.0.0.1:18893`.

Published Charge Station ports bind to `127.0.0.1`. Core is external to this
Compose project: the API reaches it through `host.docker.internal:18090` and
the simulator reaches MQTT through `host.docker.internal:18893`.

## Start the stack

Supply Core credentials through the invoking shell or a private process
environment; do not put them in this repository, a Compose file, a cookie jar,
or a checked-in `.env` file. The safe real-flow command reuses `tenant1` and
`user-a`; it reuses `IOT_CORE_DEVICE_ID` when that device exists, otherwise
provisions and assigns a fresh isolated device. It obtains the device MQTT token
by API, writes that token and the selected device ID only into a temporary
directory with mode `0700`, starts Compose, then removes that directory.

```sh
export IOT_CORE_ACCESS_TOKEN='<delegated user token>'
export CORE_TENANT_PASSWORD='<tenant1 password>'
export CORE_USER_PASSWORD='<user-a password>'
pnpm tsx scripts/core-iot-local-e2e.ts
```

The harness accepts only the two isolated `127.0.0.1` Core HTTP endpoints. It
never prints credentials. It starts services with `docker compose up -d --build
--wait` and intentionally does not run `docker compose down -v`.

The harness uses the isolated Compose project `charge-station-core-iot-e2e`,
API port `4100`, web port `3110`, and PostgreSQL port `5433` by default,
leaving the manual Compose defaults (`4000`, `3100`, and `5432`) free. Set
`CHARGE_STATION_API_HOST_PORT`, `CHARGE_STATION_WEB_HOST_PORT`,
`CHARGE_STATION_POSTGRES_HOST_PORT`, and
`CHARGE_STATION_COMPOSE_PROJECT_NAME` in the invoking environment to use
different local values. `CHARGE_STATION_API_URL` may instead select a local
`http://127.0.0.1:<port>` or `http://localhost:<port>` API origin; the harness
uses that same origin for Compose and local checkout validation.

For a manual Compose start, provide both `IOT_CORE_DEVICE_ID` and
`IOT_CORE_DEVICE_TOKEN` from your approved local Core workflow. The token is a
runtime secret and must not be copied into `.env.example` or source control.

The API waits for PostgreSQL, runs its TypeORM migrations and idempotent demo
seed, then starts. The seed creates station `ST01`, connector `ST01-C01`, and
the 5,000 VND/hour pricing plan. When `IOT_CORE_DEVICE_ID` is set, every seed
run updates `ST01` to that Core device ID, including an existing local database.
Pending persisted commands are scheduled asynchronously only after API health.

| Service            | URL or network name                                      |
| ------------------ | -------------------------------------------------------- |
| Web                | `http://localhost:3100`                                  |
| Charge Station API | `http://localhost:4000`                                  |
| API health         | `http://localhost:4000/health`                           |
| Core public API    | `http://host.docker.internal:18090` from Compose         |
| Core MQTT          | `host.docker.internal:18893` from the simulator          |
| PostgreSQL         | `postgres://charge:charge@localhost:5432/charge_station` |

The API sends two-way REST commands to Core and monitors Core telemetry. The
`core-iot-device-simulator` sidecar handles Core MQTT relay RPC and publishes
telemetry. The web build uses the configured `CHARGE_STATION_API_ORIGIN`
(default `http://127.0.0.1:4000`), because that URL is resolved by the browser,
not by the container.

Open `http://localhost:3100/scan/ST01-C01` to create a local order. With `PAYOS_MODE=mock`, checkout is an API-hosted local page and no external PayOS request is made.

Open `http://localhost:3100/admin` for station operations. Local Compose seeds
an `ADMIN` user from `ADMIN_EMAIL` and `ADMIN_PASSWORD`; the Compose defaults
are `admin@charge.local` and `local-admin-password-change-me`. Set both values
explicitly for every non-local environment.

Stop the stack:

```sh
docker compose down
```

## Environment

Copy `.env.example` when running individual services on the host. It contains
only placeholders for Core credentials. Compose intentionally sets its own
database destination and Core host bridge URL.

Local defaults:

```text
PAYOS_MODE=mock
PAYOS_MOCK_CHECKOUT_BASE_URL=http://localhost:4000
PAYOS_CHECKSUM_KEY=local-checksum-key
PAYMENT_RESERVATION_TTL_MINUTES=15
PAYMENT_REAPER_INTERVAL_MS=60000
ADMIN_EMAIL=admin@charge.local
ADMIN_PASSWORD=local-admin-password-change-me
STATION_QR_ENCRYPTION_KEY=<64-character-hex-key>
IOT_CORE_PUBLIC_URL=http://127.0.0.1:18090
IOT_CORE_ACCESS_TOKEN=<delegated-user-access-token>
IOT_CORE_DEVICE_ID=<optional-isolated-core-device-id-for-the-harness>
IOT_CORE_DEVICE_TOKEN=<isolated-core-device-token>
```

`IOT_CORE_ACCESS_TOKEN` and `IOT_CORE_DEVICE_TOKEN` are credentials. Keep them
out of terminal history, logs, committed files, and persistent cookie jars.

## Station QR Management

Sign in to `http://localhost:3100/admin`, open **Stations**, and select **Add
station**. The form needs only a station code and optional device ID. The
platform provisions its internal default charge point automatically so the
existing payment/IoT model can start charging. The resulting modal renders a
station QR and its encrypted scan URL. QR scans open
`/scan/station/<opaque-token>`; the customer chooses an available connector
without station or connector codes appearing in the URL.

`STATION_QR_ENCRYPTION_KEY` is mandatory for issuing and resolving station QR
tokens. It must be a unique 64-character hexadecimal key in each environment.
Use **Rotate QR** only when old printed QR codes must stop working: it changes
the station QR version and all older tokens return `404`.

After Core confirms a relay command, the API records the corresponding charging
state transition and the telemetry monitor updates live station measurements.
Core remains the source of truth for relay state and timer expiry.

`PAYMENT_RESERVATION_TTL_MINUTES` controls how long a newly created pending payment reserves its connector. The API starts a non-blocking reaper after its listener is ready. It claims overdue reservations, persists cancellation attempts, and only releases the connector after cancellation succeeds or PayOS definitively reports cancellation or expiry. Failed cancellation attempts remain reserved and retry with bounded backoff. `PAYMENT_REAPER_INTERVAL_MS` controls its scan interval.

## Signed Mock Webhook

The local checkout page can complete a mock payment. To test the webhook route directly, first create an order and use its `payosOrderCode` and `amountVnd` from PostgreSQL or the API test fixture. Generate a signed payload using the configured checksum key:

```sh
ORDER_CODE=1 AMOUNT=5000 PAYOS_CHECKSUM_KEY=local-checksum-key node <<'NODE'
const { createHmac } = require('node:crypto');
const data = {
  amount: Number(process.env.AMOUNT),
  orderCode: Number(process.env.ORDER_CODE),
  paymentLinkId: `mock_${process.env.ORDER_CODE}`,
  status: 'PAID',
};
const serialized = Object.entries(data)
  .filter(([, value]) => value !== null && value !== undefined && value !== '')
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([key, value]) => `${key}=${String(value)}`)
  .join('&');
const signature = createHmac('sha256', process.env.PAYOS_CHECKSUM_KEY)
  .update(serialized)
  .digest('hex');
console.log(JSON.stringify({ code: '00', success: true, data, signature }));
NODE
```

Post the JSON printed by that command to `http://localhost:4000/payments/payos/webhook`. A valid webhook creates one command. The device callback then moves the session through `STARTING`, `CHARGING`, and `COMPLETED`; a browser return or cancel URL only displays status and never starts charging.

## Payment Link Recovery

Creating an order first commits the connector reservation, order, and pending
payment transaction. PayOS payment-link creation then occurs outside the
database transaction, followed by a short transaction that stores the link.
This avoids holding a database lock while calling PayOS.

If a reservation expires while link creation is in flight, the link is not
persisted or returned to the browser, and the API attempts to cancel it at
PayOS. A local mock checkout for an expired payment shows its final status and
cannot complete the payment.

If PayOS accepts a link but its first database update fails, the order remains
recoverable. Use the returned order capability token with:

```text
GET /orders/:orderId/payment-link
Authorization: Bearer <realtimeAccessToken>
```

The endpoint returns a stored link when present. Otherwise it looks up the
existing PayOS payment request by order code and persists that same URL; it
does not create another payment link.

## PayOS Sandbox Configuration

The default `mock` mode is the correct mode for fully local development. To
exercise a PayOS sandbox checkout, set `PAYOS_MODE=live` and use sandbox
credentials issued by PayOS:

```text
PAYOS_MODE=live
PAYOS_CLIENT_ID=<sandbox-client-id>
PAYOS_API_KEY=<sandbox-api-key>
PAYOS_CHECKSUM_KEY=<sandbox-checksum-key>
PAYOS_RETURN_URL=https://<public-api-host>/payments/payos/return
PAYOS_CANCEL_URL=https://<public-api-host>/payments/payos/cancel
```

Register this sandbox webhook in the PayOS dashboard:

```text
https://<public-api-host>/payments/payos/webhook
```

PayOS cannot reach `localhost`. Use a temporary HTTPS tunnel or a
non-production deployed API host for sandbox callbacks. The signed webhook
remains the only path that can start charging.

## PayOS Production Configuration

Set `PAYOS_MODE=live` only after configuring PayOS credentials and publicly reachable HTTPS URLs. In the PayOS dashboard, configure the webhook as:

```text
https://<public-api-host>/payments/payos/webhook
```

Set the payment-link callback environment values to:

```text
PAYOS_RETURN_URL=https://<public-api-host>/payments/payos/return
PAYOS_CANCEL_URL=https://<public-api-host>/payments/payos/cancel
```

These URLs cannot be `localhost`: PayOS must reach them from the public internet. The webhook is the only callback that can activate charging, after signature, order-code, and amount verification. Return and cancel callbacks are browser redirects only and cannot change payment or charging state.

After validating a signed return or cancel callback, the API redirects to the
charge page with a short-lived order capability in the URL fragment. The web
page stores it in same-tab `sessionStorage` and immediately removes the
fragment, so the capability is not placed in a query string or referrer.

## Verification

```sh
pnpm tsx scripts/core-iot-local-e2e.ts
pnpm test
pnpm build
pnpm --filter @charge-station/api test:e2e
pnpm --filter @charge-station/api test:postgres
pnpm --filter @charge-station/web playwright test
docker compose down
```
