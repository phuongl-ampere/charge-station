# Local Development

## Prerequisites

- Docker Desktop with Compose v2.
- Node.js 22 and pnpm 9 for host-side tests and builds.

The Compose stack is self-contained and local-only. Published ports bind to `127.0.0.1`; PostgreSQL, the API, and the web app are reachable from the host. IoT remains private to the Compose network.

## Start the stack

```sh
docker compose up -d --wait
```

The API waits for PostgreSQL, runs its TypeORM migrations and idempotent demo seed, then starts. The seed creates station `ST01`, connector `ST01-C01`, and the 5,000 VND/hour pricing plan.

| Service | URL or network name |
| --- | --- |
| Web | `http://localhost:3000` |
| Charge Station API | `http://localhost:4000` |
| API health | `http://localhost:4000/health` |
| IoT Service | `http://iot-service:4001` inside Compose |
| IoT health | `http://iot-service:4001/health` inside Compose |
| PostgreSQL | `postgres://charge:charge@localhost:5432/charge_station` |

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
