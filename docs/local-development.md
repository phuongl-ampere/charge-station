# Local Development

For architecture, server-derived Station/Device status rules and the full API
inventory, read [architecture.md](architecture.md) first. This file is the
operational runbook for starting and stopping local services.

## Prerequisites

- Docker Desktop with Compose v2.
- Node.js 22 and pnpm 9 for host-side tests and builds.
- An already-running IoT Nano platform at `http://127.0.0.1:18081` and MQTT
  `127.0.0.1:18883`.

Published Charge Station ports bind to `127.0.0.1`. IoT Nano is external to
this Compose project: the API reaches it through `host.docker.internal:18081`
and the simulator reaches MQTT through `host.docker.internal:18883`.

## Start the stack

Supply the Nano system and local tenant passwords through the invoking shell;
do not put them in this repository or a checked-in `.env` file. The seed
creates or reuses the dedicated `tenant-cs` tenant, `cs-admin`, `cs-operator`,
and its Charge Station device. It rotates the Tenant Account PAT and issues a
device MQTT token, writing only those runtime secrets into the ignored
owner-only `.charge-station-iot-nano.env` file.

```sh
export IOT_NANO_SYSTEM_USERNAME='<system username>'
export IOT_NANO_SYSTEM_PASSWORD='<system password>'
export IOT_NANO_TENANT_PASSWORD='<tenant-cs password>'
export IOT_NANO_CS_ADMIN_PASSWORD='<cs-admin password>'
export IOT_NANO_CS_OPERATOR_PASSWORD='<cs-operator password>'
pnpm seed:iot-nano
docker compose --env-file .charge-station-iot-nano.env up -d --build --wait
```

The generated `IOT_NANO_PAT` has the same API authority as the Tenant Account
and is scoped to `tenant-cs`; it cannot access devices in other tenants.

For subsequent manual Compose starts, reuse the generated secret file:

```sh
docker compose --env-file .charge-station-iot-nano.env up -d --build --wait
```

The API waits for PostgreSQL, runs its TypeORM migrations and idempotent demo
seed, then starts. The seed creates station `ST01`, connector `ST01-C01`, and
the 5,000 VND/hour pricing plan. When `IOT_NANO_DEVICE_ID` is set, every seed
run updates `ST01` to that Nano device ID, including an existing local database.
Pending persisted commands are scheduled asynchronously only after API health.

| Service            | URL or network name                                      |
| ------------------ | -------------------------------------------------------- |
| Web                | `http://localhost:3100`                                  |
| Charge Station API | `http://localhost:4000`                                  |
| API health         | `http://localhost:4000/health`                           |
| IoT Nano API       | `http://host.docker.internal:18081` from Compose         |
| IoT Nano MQTT      | `host.docker.internal:18883` from the simulator          |
| PostgreSQL         | `postgres://charge:charge@localhost:5432/charge_station` |

The API sends two-way REST commands to IoT Nano and monitors Nano telemetry. The
`iot-nano-device-simulator` sidecar handles Nano MQTT relay RPC and publishes
telemetry. The web build uses the configured `CHARGE_STATION_API_ORIGIN`
(default `http://localhost:4000`), because that URL is resolved by the browser,
not by the container.

Open `http://localhost:3100/admin`, create or select a station, then open its
opaque Station QR URL to create a local order. With `PAYOS_MODE=mock`,
checkout is an API-hosted local page and no external PayOS request is made.

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
IOT_NANO_API_URL=http://127.0.0.1:18081
IOT_NANO_PAT=<tenant-cs-personal-access-token>
IOT_NANO_DEVICE_ID=<tenant-cs-device-id>
IOT_NANO_DEVICE_TOKEN=<tenant-cs-device-token>
```

`IOT_NANO_PAT` and `IOT_NANO_DEVICE_TOKEN` are credentials. Keep them
out of terminal history, logs, committed files, and persistent cookie jars.

## Station QR Management

Sign in to `http://localhost:3100/admin`, open **Stations**, and select **Add
station**. The form needs only a station code and optional device ID. The
platform provisions its internal default charge point automatically so the
existing payment/IoT model can start charging. The resulting modal renders a
station QR and its opaque scan URL. QR scans open
`/scan/station/<opaque-token>`; the customer chooses an available connector
without station or connector codes appearing in the URL.

`STATION_QR_ENCRYPTION_KEY` is mandatory for issuing and resolving station QR
tokens. It is a unique 64-character hexadecimal secret used to derive and
verify short opaque token mappings in each environment.
Use **Rotate QR** only when old printed QR codes must stop working: it changes
the station QR version and all older tokens return `404`.

After IoT Nano confirms a relay command, the API records the corresponding charging
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
pnpm seed:iot-nano
docker compose --env-file .charge-station-iot-nano.env up -d --build --wait
pnpm test
pnpm build
pnpm --filter @charge-station/api test:e2e
pnpm --filter @charge-station/api test:postgres
pnpm --filter @charge-station/web playwright test
docker compose down
```
