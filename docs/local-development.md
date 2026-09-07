# Local Development

## Prerequisites

- Docker Desktop with Compose v2.
- Node.js 22 and pnpm 9 for host-side tests and builds.

The Compose stack is self-contained and local-only. Published ports bind to `127.0.0.1`; PostgreSQL, the API, and the web app are reachable from the host. IoT remains private to the Compose network.

## Start the stack

```sh
docker compose up -d --wait
```

The API waits for PostgreSQL, runs its TypeORM migrations and idempotent demo seed, then starts. The seed creates station `ST01`, connector `ST01-C01`, and the 5,000 VND/hour pricing plan. API health becomes available when its HTTP listener is ready. Pending persisted IoT commands are scheduled asynchronously only after that point, so Compose can start IoT after API health without consuming command retries before IoT is available.

| Service            | URL or network name                                      |
| ------------------ | -------------------------------------------------------- |
| Web                | `http://localhost:3000`                                  |
| Charge Station API | `http://localhost:4000`                                  |
| API health         | `http://localhost:4000/health`                           |
| IoT Service        | `http://iot-service:4001` inside Compose                 |
| IoT health         | `http://iot-service:4001/health` inside Compose          |
| PostgreSQL         | `postgres://charge:charge@localhost:5432/charge_station` |

The API calls IoT at `http://iot-service:4001`; IoT posts device events to `http://charge-station-api:4000`. The web build uses `http://localhost:4000`, because that URL is resolved by the browser, not by the container.

Open `http://localhost:3000/scan/ST01-C01` to create a local order. With `PAYOS_MODE=mock`, checkout is an API-hosted local page and no external PayOS request is made.

Stop the stack:

```sh
docker compose down
```

Reset the database:

```sh
docker compose down -v
```

## Environment

Copy `.env.example` when running individual services on the host. It defines host-local URLs. Compose intentionally sets its own database and internal service destinations so that service-to-service calls use Docker DNS names.

Local defaults:

```text
PAYOS_MODE=mock
PAYOS_MOCK_CHECKOUT_BASE_URL=http://localhost:4000
PAYOS_CHECKSUM_KEY=local-checksum-key
MOCK_IOT_FAILURE_MODE=none
```

The mock IoT service accepts `MOCK_IOT_FAILURE_MODE=timeout`, `offline`, or `command_failed` to exercise command failure paths. `MOCK_IOT_START_DELAY_MS` and `MOCK_IOT_HEARTBEAT_MS` control the mock timing. Change an environment value in `docker-compose.yml`, then recreate the affected service.

`STOPPED`, `COMMAND_FAILED`, and `DEVICE_OFFLINE` callbacks retain their original event ID and retry after 100 ms, 500 ms, then a capped 1 second interval until the API acknowledges them. The mock clears retry timers on shutdown. Nonterminal callbacks remain best effort.

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
non-production deployed API host for sandbox callbacks. Keep the local mock
IoT Service enabled while validating sandbox checkout. The signed webhook
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

## Verification

```sh
docker compose up -d --wait
pnpm test
pnpm build
pnpm --filter @charge-station/api test:e2e
pnpm --filter @charge-station/web playwright test
docker compose down
```
