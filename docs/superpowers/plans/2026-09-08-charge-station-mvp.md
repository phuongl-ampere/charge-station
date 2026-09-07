# Charge Station MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable QR-to-PayOS-to-IoT charging MVP with a Next.js frontend, independent NestJS Charge Station and mock IoT services, and PostgreSQL persistence.

**Architecture:** A pnpm workspace contains three deployable applications and one shared contracts package. Charge Station owns orders, PayOS payment confirmation, charging sessions, and realtime notifications; the mock IoT Service owns device timer and relay simulation. The two services communicate only through authenticated HTTP command and event contracts.

**Tech Stack:** Node.js 22, pnpm workspaces, Next.js 15, NestJS 11, TypeORM, PostgreSQL 16, Socket.IO, Axios, Vitest, React Testing Library, Supertest, Playwright, Docker Compose.

## Global Constraints

- Use TypeScript with `strict: true`; all production code must be ASCII.
- Use Node.js 22 and pnpm 9 with a committed `pnpm-lock.yaml`.
- Keep `apps/charge-station-api`, `apps/iot-service`, and `apps/web` independently runnable.
- Store money as integer VND; 5,000 VND/hour is the only MVP price.
- Use PayOS only. Required environment variables are `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY`, `PAYOS_RETURN_URL`, and `PAYOS_CANCEL_URL`.
- The device owns the timer and relay. Charge Station may estimate remaining time but must never use its timer to switch the relay off.
- Treat only a verified PayOS webhook as payment confirmation. Return and cancel browser redirects are display-only.
- Use a unique positive numeric `payosOrderCode` for every order. It must fit in `Number.MAX_SAFE_INTEGER` before calling PayOS.
- Generate PayOS signatures from non-empty fields sorted alphabetically, joined as `key=value` with `&`, using HMAC-SHA256 and the checksum key. Compare signatures with `timingSafeEqual`.
- Do not expose IoT Service to the public browser. Protect service-to-service APIs with `X-Service-Token`.
- Send `START_CHARGING` only once for a successfully paid order; use idempotent rows and database transactions to prevent duplicate webhooks from duplicating relay commands.
- Build and run tests before each task is marked complete. Do not add production behavior before its failing test exists.

## Reference Findings

The PayOS implementation in `/Users/phuongl/myai/projects/fuvi/wemake` establishes the payment pattern used here:

- `backend/src/payments/payos.service.ts:createPaymentLink` sends `POST https://api-merchant.payos.vn/v2/payment-requests`, rounds VND, restricts the description to 25 ASCII characters, and signs `amount`, `cancelUrl`, `description`, `orderCode`, and `returnUrl`.
- `backend/src/payments/payos.service.ts:verifyWebhookSignature` sorts non-empty `data` fields alphabetically before HMAC verification.
- `backend/src/payments/payments.service.ts:handlePayosWebhook` verifies the signature, resolves `orderCode`, checks the received amount, and treats an already-completed payment as idempotently successful.
- `backend/src/payments/payments.controller.ts:payosWebhook` keeps the server-to-server webhook separate from browser return/cancel handlers.

## File Structure

```text
.
├── apps/
│   ├── charge-station-api/
│   │   ├── src/{auth,connectors,orders,payments,charging,iot,realtime,database}/
│   │   └── test/
│   ├── iot-service/
│   │   ├── src/{commands,devices,events}/
│   │   └── test/
│   └── web/
│       ├── app/
│       ├── components/
│       └── lib/
├── packages/contracts/src/
├── docker-compose.yml
├── package.json
├── pnpm-workspace.yaml
└── .env.example
```

---

### Task 1: Create the workspace, local runtime, and test baseline

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `docker-compose.yml`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/vitest.config.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/health.test.ts`
- Create: `apps/charge-station-api/package.json`
- Create: `apps/iot-service/package.json`
- Create: `apps/web/package.json`

**Interfaces:**
- Produces workspace aliases `@charge-station/contracts`, `@charge-station/api`, `@charge-station/iot-service`, and `@charge-station/web`.
- Produces a PostgreSQL service at `postgres://charge:charge@localhost:5432/charge_station`.

- [ ] **Step 1: Write the failing contracts test**

```ts
import { describe, expect, it } from 'vitest';
import { APP_NAME } from './index';

describe('contracts package', () => {
  it('exports its application identity', () => {
    expect(APP_NAME).toBe('charge-station');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @charge-station/contracts test`

Expected: command fails because the workspace and `APP_NAME` export do not exist.

- [ ] **Step 3: Create minimal workspace implementation**

Create a root package with `dev`, `build`, `test`, `lint`, and `format` scripts that delegate through pnpm workspaces. Configure `pnpm-workspace.yaml` for `apps/*` and `packages/*`, enable strict TypeScript in `tsconfig.base.json`, and export:

```ts
export const APP_NAME = 'charge-station';
```

Configure Docker Compose PostgreSQL 16 with a health check, named volume, database `charge_station`, user `charge`, and password `charge`. Add `.env.example` with database, JWT, PayOS, frontend, IoT Service, and service-token variables.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm --filter @charge-station/contracts test && pnpm --filter @charge-station/contracts build`

Expected: one passing test and a successful TypeScript build.

- [ ] **Step 5: Initialize the repository**

Run: `git init`

Expected: the workspace becomes a Git repository before the first checkpoint commit.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .gitignore .env.example docker-compose.yml packages apps
git commit -m "chore: scaffold charge station workspace"
```

### Task 2: Define shared contracts and test price calculation

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/payment.ts`
- Create: `packages/contracts/src/iot.ts`
- Create: `packages/contracts/src/pricing.ts`
- Create: `packages/contracts/src/pricing.test.ts`

**Interfaces:**
- Produces `calculateAmountVnd(durationMinutes: number): number`.
- Produces `PaymentStatus`, `ChargingStatus`, `DeviceCommandType`, `PayosWebhook`, `StartChargingCommand`, and `DeviceEvent`.
- Consumed by both NestJS services and the Next.js application.

- [ ] **Step 1: Write the failing price test**

```ts
import { describe, expect, it } from 'vitest';
import { calculateAmountVnd } from './pricing';

describe('calculateAmountVnd', () => {
  it.each([
    [60, 5000],
    [120, 10000],
    [180, 15000],
  ])('charges %i minutes as %i VND', (minutes, expected) => {
    expect(calculateAmountVnd(minutes)).toBe(expected);
  });

  it('rejects a duration that is not a whole hour', () => {
    expect(() => calculateAmountVnd(90)).toThrow('Duration must be a whole number of hours');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @charge-station/contracts test -- pricing.test.ts`

Expected: TypeScript reports that `calculateAmountVnd` is not exported.

- [ ] **Step 3: Implement the contract primitives**

Implement the price function as `5000 * (durationMinutes / 60)` after requiring a positive integer duration divisible by 60. Define the service contract:

```ts
export interface StartChargingCommand {
  commandId: string;
  sessionId: string;
  stationCode: string;
  connectorCode: string;
  durationSeconds: number;
  expiresAt: string;
  configVersion: number;
}

export interface DeviceEvent {
  eventId: string;
  commandId: string;
  sessionId: string;
  deviceId: string;
  connectorCode: string;
  type: 'COMMAND_ACCEPTED' | 'RUNNING' | 'HEARTBEAT' | 'STOPPED' | 'COMMAND_FAILED' | 'DEVICE_OFFLINE';
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface PayosWebhook {
  code: string;
  desc: string;
  success: boolean;
  data: Record<string, string | number | boolean | null>;
  signature: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @charge-station/contracts test`

Expected: all contracts tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts
git commit -m "feat: define charging and payment contracts"
```

### Task 3: Implement Charge Station database schema, connector lookup, and JWT authentication

**Files:**
- Create: `apps/charge-station-api/src/main.ts`
- Create: `apps/charge-station-api/src/app.module.ts`
- Create: `apps/charge-station-api/src/database/data-source.ts`
- Create: `apps/charge-station-api/src/database/migrations/001-initial-schema.ts`
- Create: `apps/charge-station-api/src/database/seed.ts`
- Create: `apps/charge-station-api/src/auth/auth.module.ts`
- Create: `apps/charge-station-api/src/auth/auth.controller.ts`
- Create: `apps/charge-station-api/src/auth/auth.service.ts`
- Create: `apps/charge-station-api/src/auth/jwt-auth.guard.ts`
- Create: `apps/charge-station-api/src/connectors/connectors.module.ts`
- Create: `apps/charge-station-api/src/connectors/connectors.controller.ts`
- Create: `apps/charge-station-api/src/connectors/connectors.service.ts`
- Create: `apps/charge-station-api/src/connectors/connectors.service.spec.ts`

**Interfaces:**
- Produces public `GET /public/connectors/:connectorCode`.
- Produces `POST /auth/register` and `POST /auth/login`, each returning `{ accessToken: string }`.
- Produces entities `User`, `Station`, `Connector`, `Order`, `PaymentTransaction`, `ChargingSession`, `DeviceCommand`, and `DeviceEvent`.

- [ ] **Step 1: Write the failing connector availability test**

```ts
it('returns an available connector with permitted durations and price', async () => {
  repository.findOneBy.mockResolvedValue({
    code: 'ST01-C01',
    status: 'AVAILABLE',
    station: { code: 'ST01', name: 'Demo Station' },
  });

  await expect(service.getPublicConnector('ST01-C01')).resolves.toEqual({
    stationCode: 'ST01',
    connectorCode: 'ST01-C01',
    status: 'AVAILABLE',
    allowedDurationsMinutes: [60, 120, 180],
    hourlyPriceVnd: 5000,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @charge-station/api test -- connectors.service.spec.ts`

Expected: failure because `ConnectorsService` is missing.

- [ ] **Step 3: Implement schema, auth, and connector service**

Use UUID primary keys except for `orders.payosOrderCode`, which is a database-generated positive `bigint` from `payos_order_code_seq` with a unique constraint. Persist integer VND values. Seed `ST01` with connector `ST01-C01` in `AVAILABLE` state. Hash credentials with bcrypt, issue JWTs with a stable `sub` and `role`, and protect only future management endpoints; keep QR connector lookup public.

- [ ] **Step 4: Run focused and integration tests**

Run: `pnpm --filter @charge-station/api test -- connectors.service.spec.ts && pnpm --filter @charge-station/api test:e2e -- connectors.e2e-spec.ts`

Expected: connector service and public API behavior pass against test PostgreSQL.

- [ ] **Step 5: Commit**

```bash
git add apps/charge-station-api
git commit -m "feat: add charge station persistence and auth"
```

### Task 4: Implement PayOS checkout creation and verified webhook processing

**Files:**
- Create: `apps/charge-station-api/src/payments/payments.module.ts`
- Create: `apps/charge-station-api/src/payments/payments.controller.ts`
- Create: `apps/charge-station-api/src/payments/payments.service.ts`
- Create: `apps/charge-station-api/src/payments/payos.client.ts`
- Create: `apps/charge-station-api/src/payments/payos-signature.ts`
- Create: `apps/charge-station-api/src/payments/dto/create-order.dto.ts`
- Create: `apps/charge-station-api/src/payments/payos-signature.spec.ts`
- Create: `apps/charge-station-api/src/payments/payments.service.spec.ts`
- Create: `apps/charge-station-api/src/payments/payments.e2e-spec.ts`

**Interfaces:**
- Produces `POST /orders` with `{ connectorCode, durationMinutes }` and response `{ orderId, amount, currency, payment: { provider, checkoutUrl } }`.
- Produces `POST /payments/payos/webhook` accepting `PayosWebhook`.
- Produces public `GET /payments/payos/return` and `GET /payments/payos/cancel` that validate query signatures and redirect to the frontend charge-status route without changing payment state.
- Produces `PayosClient.createPaymentLink(input): Promise<{ checkoutUrl: string; paymentLinkId: string }>` and `PayosClient.verifyWebhook(data, signature): boolean`.

- [ ] **Step 1: Write the failing PayOS signature tests**

```ts
it('signs sorted non-empty webhook data', () => {
  expect(buildPayosSignature(
    { amount: 10000, orderCode: 100001, status: 'PAID', ignored: '' },
    'checksum-key',
  )).toBe('fdfdaefba61fa5a11bf98f4642fde8e875b984116b0a9a1f48990793dbabf47f');
});

it('rejects a signature with the wrong checksum key', () => {
  expect(verifyPayosSignature({ orderCode: 100001 }, 'not-valid', 'checksum-key')).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @charge-station/api test -- payos-signature.spec.ts`

Expected: failure because PayOS signature functions are missing.

- [ ] **Step 3: Implement the PayOS client**

Create a 25-character ASCII-only description such as `Charge ST01C01 2h`. Round VND before signing. Create the signing string exactly:

```ts
const signingData =
  `amount=${amount}` +
  `&cancelUrl=${cancelUrl}` +
  `&description=${description}` +
  `&orderCode=${orderCode}` +
  `&returnUrl=${returnUrl}`;
```

Sign with HMAC-SHA256 and call `POST https://api-merchant.payos.vn/v2/payment-requests` using `x-client-id`, `x-api-key`, and JSON headers. Require response `code === '00'` and persist its `checkoutUrl` and payment link ID.

- [ ] **Step 4: Write the failing webhook business-flow test**

```ts
it('marks the order paid and creates exactly one start command for a valid webhook', async () => {
  const body = signedWebhook({
    orderCode: pendingOrder.payosOrderCode,
    amount: pendingOrder.amountVnd,
    paymentLinkId: 'pl_123',
    status: 'PAID',
  });

  await service.handleWebhook(body);
  await service.handleWebhook(body);

  expect(orderRepository.markPaid).toHaveBeenCalledTimes(1);
  expect(commandRepository.createStartCommand).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm --filter @charge-station/api test -- payments.service.spec.ts`

Expected: failure because webhook processing is missing.

- [ ] **Step 6: Implement order creation and webhook processing**

On `POST /orders`, validate an available connector and whole-hour duration, allocate and persist the unique `payosOrderCode`, create a `PENDING_PAYMENT` payment transaction, create the PayOS link, and return only `checkoutUrl`.

On webhook:

1. Verify HMAC signature with `timingSafeEqual`.
2. Parse a valid positive numeric `orderCode` and find the persisted order.
3. Lock the payment transaction in a PostgreSQL transaction.
4. Return success without mutation if it is already paid.
5. Compare rounded incoming amount to `orders.amountVnd`.
6. Process only `code === '00' && success === true`.
7. Mark the order and payment transaction paid, persist raw payload and payment link ID, create one `PENDING` charging session and one `START_CHARGING` device command.
8. Persist cancellation or expiration as a non-paid payment state without creating a charging session.

The browser return and cancel handlers may validate their PayOS signature and redirect to `${FRONTEND_URL}/charge/{orderId}`, but they must not mark an order paid or create a device command.

- [ ] **Step 7: Run PayOS test suite**

Run: `pnpm --filter @charge-station/api test -- payos-signature.spec.ts payments.service.spec.ts && pnpm --filter @charge-station/api test:e2e -- payments.e2e-spec.ts`

Expected: valid signed webhooks complete payment once; invalid signature, unknown order, and amount mismatch never create a session or command.

- [ ] **Step 8: Commit**

```bash
git add apps/charge-station-api/src/payments apps/charge-station-api/test
git commit -m "feat: add verified PayOS checkout and webhook"
```

### Task 5: Implement the independent mock IoT Service

**Files:**
- Create: `apps/iot-service/src/main.ts`
- Create: `apps/iot-service/src/app.module.ts`
- Create: `apps/iot-service/src/commands/commands.controller.ts`
- Create: `apps/iot-service/src/commands/commands.service.ts`
- Create: `apps/iot-service/src/devices/device-state.service.ts`
- Create: `apps/iot-service/src/events/charge-station-event.client.ts`
- Create: `apps/iot-service/src/common/service-token.guard.ts`
- Create: `apps/iot-service/src/commands/commands.service.spec.ts`
- Create: `apps/iot-service/src/commands/commands.e2e-spec.ts`

**Interfaces:**
- Produces `POST /internal/commands/start` and `POST /internal/commands/stop`.
- Consumes `StartChargingCommand` and returns `{ commandId, accepted, deviceId, status }`.
- Calls Charge Station `POST /internal/device-events` with a `DeviceEvent`.

- [ ] **Step 1: Write the failing timer test**

```ts
it('emits RUNNING and then STOPPED with TIMER_EXPIRED for an accepted start command', async () => {
  await service.start(commandWithDuration(2));

  await vi.advanceTimersByTimeAsync(100);
  expect(eventClient.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'RUNNING' }));

  await vi.advanceTimersByTimeAsync(2000);
  expect(eventClient.post).toHaveBeenCalledWith(expect.objectContaining({
    type: 'STOPPED',
    payload: expect.objectContaining({ reason: 'TIMER_EXPIRED', relayState: 'OFF' }),
  }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @charge-station/iot-service test -- commands.service.spec.ts`

Expected: failure because the mock command service does not exist.

- [ ] **Step 3: Implement device simulation**

Require `X-Service-Token` on both command routes. Maintain in-memory state keyed by `connectorCode`, reject a start request for a connector already `RUNNING`, and deduplicate repeated `commandId` values. For each accepted command:

1. Post `COMMAND_ACCEPTED`.
2. After `MOCK_IOT_START_DELAY_MS`, set relay state to `ON` and post `RUNNING`.
3. Emit `HEARTBEAT` at `MOCK_IOT_HEARTBEAT_MS` with `remainingSeconds`.
4. At `durationSeconds`, set relay state to `OFF`, clear timers, and post `STOPPED` with `reason: TIMER_EXPIRED`.

The stop route clears timers, turns relay state off, and emits `STOPPED` with the supplied reason. `MOCK_IOT_FAILURE_MODE` supports `none`, `timeout`, `offline`, and `command_failed` for tests and manual development.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @charge-station/iot-service test && pnpm --filter @charge-station/iot-service test:e2e -- commands.e2e-spec.ts`

Expected: the accepted command starts and stops exactly once; duplicate commands and occupied connectors do not create a second timer.

- [ ] **Step 5: Commit**

```bash
git add apps/iot-service
git commit -m "feat: add mock iot timer service"
```

### Task 6: Dispatch IoT commands and consume authenticated device events

**Files:**
- Create: `apps/charge-station-api/src/iot/iot.module.ts`
- Create: `apps/charge-station-api/src/iot/iot-service.client.ts`
- Create: `apps/charge-station-api/src/iot/device-events.controller.ts`
- Create: `apps/charge-station-api/src/iot/device-events.service.ts`
- Create: `apps/charge-station-api/src/iot/command-dispatcher.service.ts`
- Create: `apps/charge-station-api/src/iot/device-events.service.spec.ts`
- Create: `apps/charge-station-api/src/iot/command-dispatcher.service.spec.ts`

**Interfaces:**
- Consumes persisted `DeviceCommand` rows and calls IoT Service.
- Consumes `POST /internal/device-events` with `DeviceEvent`.
- Produces charging session transitions `PENDING -> STARTING -> CHARGING -> COMPLETED | CANCELLED | START_FAILED`.

- [ ] **Step 1: Write the failing device-event idempotency test**

```ts
it('changes a session to CHARGING once when RUNNING arrives twice', async () => {
  await service.handle(runningEvent);
  await service.handle({ ...runningEvent, eventId: 'evt_duplicate_delivery' });

  expect(sessionRepository.updateStatus).toHaveBeenCalledTimes(1);
  expect(sessionRepository.updateStatus).toHaveBeenCalledWith(
    runningEvent.sessionId,
    'CHARGING',
    expect.objectContaining({ startedAt: expect.any(Date) }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @charge-station/api test -- device-events.service.spec.ts`

Expected: failure because device event handling is missing.

- [ ] **Step 3: Implement dispatcher and event consumer**

After the webhook transaction commits, dispatch the persisted `START_CHARGING` command. Mark it `SENT` only after an accepted HTTP response; retry transport failures at most three times with delays of 1, 5, and 20 seconds. Never regenerate `commandId`, `durationSeconds`, or `expiresAt`.

Require `X-Service-Token` for `/internal/device-events`, reject duplicated `eventId` values, and persist every accepted event. Process transitions as follows:

- `COMMAND_ACCEPTED`: retain session `STARTING`.
- `RUNNING`: set session `CHARGING` with `startedAt`; record relay as on.
- `HEARTBEAT`: update estimated `remainingSeconds` and `lastDeviceEventAt`.
- `STOPPED` with `TIMER_EXPIRED`: set session `COMPLETED`.
- `STOPPED` with another reason: set session `CANCELLED`.
- `COMMAND_FAILED`: set session `START_FAILED`.
- `DEVICE_OFFLINE`: retain the session and set an operational warning.

- [ ] **Step 4: Run focused tests**

Run: `pnpm --filter @charge-station/api test -- device-events.service.spec.ts command-dispatcher.service.spec.ts`

Expected: duplicate events do not repeat state changes; a valid `RUNNING` event is the only path to `CHARGING`.

- [ ] **Step 5: Commit**

```bash
git add apps/charge-station-api/src/iot apps/charge-station-api/src/charging
git commit -m "feat: dispatch iot commands and consume device events"
```

### Task 7: Expose order and session status with Socket.IO updates

**Files:**
- Create: `apps/charge-station-api/src/orders/orders.module.ts`
- Create: `apps/charge-station-api/src/orders/orders.controller.ts`
- Create: `apps/charge-station-api/src/orders/orders.service.ts`
- Create: `apps/charge-station-api/src/charging/charging.module.ts`
- Create: `apps/charge-station-api/src/charging/charging.controller.ts`
- Create: `apps/charge-station-api/src/realtime/realtime.module.ts`
- Create: `apps/charge-station-api/src/realtime/charge.gateway.ts`
- Create: `apps/charge-station-api/src/charging/charging.controller.spec.ts`

**Interfaces:**
- Produces `GET /orders/:id`, `GET /sessions/:id`, and `POST /sessions/:id/stop`.
- Produces Socket.IO rooms `order:{orderId}` and `session:{sessionId}`.
- Publishes `payment.updated`, `session.updated`, and `device.updated`.

- [ ] **Step 1: Write the failing status projection test**

```ts
it('returns an estimated remaining time without claiming it controls the device timer', async () => {
  const response = await controller.getSession('ses_1');

  expect(response).toMatchObject({
    id: 'ses_1',
    status: 'CHARGING',
    estimatedRemainingSeconds: 3450,
    timerAuthority: 'DEVICE',
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @charge-station/api test -- charging.controller.spec.ts`

Expected: failure because charging-status projection is missing.

- [ ] **Step 3: Implement REST and realtime adapters**

Use server-side event publishers from payment and device-event services, not HTTP controllers, to emit:

```ts
gateway.publishOrder(orderId, 'payment.updated', orderStatus);
gateway.publishSession(sessionId, 'session.updated', sessionStatus);
gateway.publishSession(sessionId, 'device.updated', deviceSnapshot);
```

The stop endpoint creates a persistent `STOP_CHARGING` command and uses the same dispatcher as start. It returns `202 Accepted`; it must not report the session as stopped before a device `STOPPED` event.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @charge-station/api test && pnpm --filter @charge-station/api build`

Expected: status payload accurately identifies the device as timer authority and all API tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/charge-station-api/src/orders apps/charge-station-api/src/charging apps/charge-station-api/src/realtime
git commit -m "feat: expose charge status and realtime updates"
```

### Task 8: Build the Next.js QR checkout and charging status workflow

**Files:**
- Create: `apps/web/app/layout.tsx`
- Create: `apps/web/app/page.tsx`
- Create: `apps/web/app/scan/[connectorCode]/page.tsx`
- Create: `apps/web/app/charge/[orderId]/page.tsx`
- Create: `apps/web/components/DurationPicker.tsx`
- Create: `apps/web/components/PayosCheckout.tsx`
- Create: `apps/web/components/ChargingStatus.tsx`
- Create: `apps/web/lib/api.ts`
- Create: `apps/web/lib/socket.ts`
- Create: `apps/web/components/DurationPicker.test.tsx`
- Create: `apps/web/components/ChargingStatus.test.tsx`
- Create: `apps/web/playwright.config.ts`
- Create: `apps/web/e2e/checkout.spec.ts`

**Interfaces:**
- Consumes `GET /public/connectors/:connectorCode`, `POST /orders`, `GET /orders/:id`, and `GET /sessions/:id`.
- Opens PayOS `checkoutUrl`; renders a convenience QR encoding the checkout URL with `qrcode.react`.
- Consumes Socket.IO events while polling status every 5 seconds when disconnected.

- [ ] **Step 1: Write the failing duration-picker test**

```tsx
it('selects two hours and shows the server price format', async () => {
  const user = userEvent.setup();
  render(<DurationPicker durations={[60, 120]} hourlyPriceVnd={5000} onSelect={onSelect} />);

  await user.click(screen.getByRole('button', { name: '2 hours' }));

  expect(onSelect).toHaveBeenCalledWith(120);
  expect(screen.getByText('10,000 VND')).toBeVisible();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @charge-station/web test -- DurationPicker.test.tsx`

Expected: failure because the component does not exist.

- [ ] **Step 3: Implement the customer flow**

On `/scan/[connectorCode]`, fetch connector status, render fixed 1, 2, and 3 hour selections supplied by the API, and submit only `connectorCode` and `durationMinutes`. Display the total returned by the API.

After order creation, render `PayosCheckout` with a button opening `checkoutUrl` and a QR generated from that URL. Do not claim payment success after return navigation. Navigate to `/charge/{orderId}`, subscribe to `order:{orderId}`, and render `PENDING_PAYMENT`, `PAID`, `STARTING`, `CHARGING`, `COMPLETED`, and failure states. Begin session polling only after a session ID is available.

Use operational styling: compact controls, clear monetary values, and no marketing landing page.

- [ ] **Step 4: Write the failing realtime fallback test**

```tsx
it('polls session status every five seconds after socket disconnect', async () => {
  render(<ChargingStatus orderId="ord_1" socket={disconnectedSocket} api={api} />);

  await vi.advanceTimersByTimeAsync(5000);

  expect(api.getOrder).toHaveBeenCalledWith('ord_1');
});
```

- [ ] **Step 5: Run tests and browser workflow**

Run: `pnpm --filter @charge-station/web test && pnpm --filter @charge-station/web build && pnpm --filter @charge-station/web playwright test`

Expected: component tests pass, production build succeeds, and Playwright verifies selecting a duration, opening the PayOS checkout URL, and rendering the waiting-for-payment status.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat: add QR checkout and charging UI"
```

### Task 9: Verify the full mock payment-to-charging lifecycle and document operations

**Files:**
- Create: `apps/charge-station-api/test/charge-lifecycle.e2e-spec.ts`
- Create: `README.md`
- Create: `docs/local-development.md`
- Modify: `docs/charge-station-design.md`
- Modify: `.env.example`

**Interfaces:**
- Verifies the complete path from connector lookup through PayOS webhook, command dispatch, mock-device timer event, and frontend-visible session state.
- Documents Docker Compose startup, PayOS sandbox configuration, service URLs, test webhook generation, and mock failure modes.

- [ ] **Step 1: Write the failing full-lifecycle E2E test**

```ts
it('starts one device timer only after a verified PayOS webhook', async () => {
  const order = await createOrder('ST01-C01', 60);
  expect(mockIotService.commands).toHaveLength(0);

  await postPayosWebhook({
    orderCode: order.payosOrderCode,
    amount: 5000,
    success: true,
    code: '00',
  });

  await waitFor(() => expect(mockIotService.commands).toHaveLength(1));
  expect(await getSession(order.id)).toMatchObject({ status: 'CHARGING', timerAuthority: 'DEVICE' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @charge-station/api test:e2e -- charge-lifecycle.e2e-spec.ts`

Expected: failure before the services are composed and the test helpers exist.

- [ ] **Step 3: Implement E2E wiring and documentation**

Run PostgreSQL, Charge Station API, IoT Service, and the frontend in Docker Compose. Add health endpoints to both APIs. Configure the E2E suite with a test PayOS HTTP adapter that records payment-link creation and signs its webhook fixture using `PAYOS_CHECKSUM_KEY`.

Document these required production configuration rules:

```text
PayOS dashboard webhook:
https://<public-api-host>/payments/payos/webhook

PayOS return URL:
https://<public-api-host>/payments/payos/return

PayOS cancel URL:
https://<public-api-host>/payments/payos/cancel
```

Document that public PayOS callback URLs cannot be `localhost`, that only the webhook activates charging, and that real device protocol replacement is isolated to IoT Service.

- [ ] **Step 4: Run full verification**

Run: `docker compose up -d --wait && pnpm test && pnpm build && pnpm --filter @charge-station/api test:e2e && pnpm --filter @charge-station/web playwright test && docker compose down`

Expected: all workspace unit tests, API E2E tests, browser tests, and production builds succeed.

- [ ] **Step 5: Commit**

```bash
git add README.md docs .env.example docker-compose.yml apps/charge-station-api/test
git commit -m "test: verify charge payment lifecycle"
```

## Plan Self-Review

### Spec Coverage

- QR connector discovery, time selection, server-side 5,000 VND/hour calculation, and frontend amount display: Tasks 2, 3, and 8.
- NestJS, TypeORM, PostgreSQL, and JWT authentication: Tasks 1 and 3.
- Separate IoT Service with mocked API and device-owned timer: Tasks 5 and 6.
- PayOS payment-link creation, return/cancel display flow, verified webhook, and idempotency: Task 4.
- Device command, relay confirmation, session transitions, and automatic timer stop: Tasks 5 and 6.
- Socket.IO status updates with polling fallback: Task 7 and Task 8.
- Payment, command, and event persistence with unique identifiers: Tasks 3, 4, and 6.
- Security, signature checks, amount validation, service authentication, and integration proof: Tasks 4, 6, and 9.

### Consistency Checks

- `payosOrderCode` is the unique numeric payment identifier in the schema, PayOS client, webhook, and E2E test.
- `START_CHARGING` is created inside the paid webhook transaction, dispatched after commit, and accepted by IoT Service exactly once per `commandId`.
- Only an IoT `RUNNING` event moves a session to `CHARGING`; only IoT `STOPPED` confirms relay off.
- Browser return and cancel routes are intentionally excluded from payment state changes.
