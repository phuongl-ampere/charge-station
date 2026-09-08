# P1 Ambiguous Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent unavailable IoT and ambiguous PayOS outcomes from consuming command retries or releasing reservations that may still complete.

**Architecture:** `CommandDispatcherService` owns a shared, nonblocking readiness queue. It probes the bounded `IotServiceClient.isHealthy()` request on the existing capped schedule and only calls the raw dispatcher after a healthy result. `PayosClient` exposes typed definitive and ambiguous create failures; `PaymentsService` compensates only definitive outcomes, otherwise reconciles by order code and returns a pending payment response with the existing order capability.

**Tech Stack:** NestJS, TypeORM, Axios, Vitest, pg-mem, PostgreSQL.

## Global Constraints

- Modify API and shared API contracts only; do not modify `apps/web`.
- Keep `GET /orders/:id/payment-link` authorization through `ChargeGateway.authorizeOrder` unchanged.
- Keep webhook signature verification before database work unchanged.
- Use the existing 1 second IoT health-probe timeout and capped readiness retry schedule.
- A failed health probe must not mutate `DeviceCommand.retryCount`, command status, or `nextAttemptAt`.

---

### Task 1: Gate post-payment and retry dispatch behind readiness

**Files:**

- Modify: `apps/charge-station-api/src/iot/command-dispatcher.service.ts`
- Modify: `apps/charge-station-api/src/payments/payments.service.ts`
- Modify: `apps/charge-station-api/src/charging/charging.service.ts`
- Test: `apps/charge-station-api/src/iot/command-dispatcher.service.spec.ts`
- Test: `apps/charge-station-api/src/payments/payments.service.spec.ts`
- Test: `apps/charge-station-api/src/charging/charging.postgres-spec.ts`

**Interfaces:**

- Produces: `CommandDispatcherService.dispatchWhenIotReady(commandId: string): void`.
- Consumes: `IotServiceClient.isHealthy(): Promise<boolean>` and existing `dispatch(commandId)`.

- [ ] **Step 1: Write failing readiness tests**

```ts
service.dispatchWhenIotReady(command.commandId);
await Promise.resolve();
expect(command).toMatchObject({
  status: DeviceCommandStatus.PENDING,
  retryCount: 0,
});
expect(iotClient.start).not.toHaveBeenCalled();
await vi.advanceTimersByTimeAsync(250);
expect(iotClient.start).toHaveBeenCalledTimes(1);
```

Add coverage that the payment webhook and `ChargingService.retryStart` invoke `dispatchWhenIotReady`, not raw `dispatch`.

- [ ] **Step 2: Run focused tests and observe failure**

Run: `pnpm --filter @charge-station/api exec vitest run src/iot/command-dispatcher.service.spec.ts src/payments/payments.service.spec.ts`

Expected: the readiness method is absent or existing callers use `dispatch`.

- [ ] **Step 3: Implement the shared readiness queue**

```ts
dispatchWhenIotReady(commandId: string): void {
  this.commandsAwaitingIotReadiness.add(commandId);
  this.ensureIotReadinessProbe();
}
```

Use a `Set` to coalesce duplicate command IDs. On a healthy probe, drain startup recovery and queued IDs with `dispatch`; on an unhealthy probe, schedule only another health probe. Switch post-payment and retry-start dispatch wrappers to this method.

- [ ] **Step 4: Run readiness tests and PostgreSQL retry coverage**

Run: `pnpm --filter @charge-station/api exec vitest run src/iot/command-dispatcher.service.spec.ts src/payments/payments.service.spec.ts`

Run: `pnpm --filter @charge-station/api test:postgres -- src/charging/charging.postgres-spec.ts`

Expected: the command remains pending at retry zero until one healthy probe dispatches it once.

### Task 2: Classify PayOS create outcomes and preserve ambiguous reservations

**Files:**

- Modify: `apps/charge-station-api/src/payments/payos.client.ts`
- Modify: `apps/charge-station-api/src/payments/payments.service.ts`
- Test: `apps/charge-station-api/src/payments/payos.client.spec.ts`
- Test: `apps/charge-station-api/src/payments/payments.service.spec.ts`

**Interfaces:**

- Produces: `PayosPaymentLinkDefinitiveError` and `PayosPaymentLinkAmbiguousError` from `PayosClient`.
- Produces: `PaymentsService.createOrder()` payment result with either a checkout URL or `{ paymentPending: true }`, always including the existing capability when `ChargeGateway` is present.
- Consumes: `PayosClient.getPaymentLinkInfo(orderCode)` for reconciliation.

- [ ] **Step 1: Write failing classification and pending-order tests**

```ts
await expect(client.createPaymentLink(input)).rejects.toBeInstanceOf(
  PayosPaymentLinkAmbiguousError,
);
await expect(service.createOrder(input)).resolves.toMatchObject({
  payment: { provider: "PAYOS", paymentPending: true },
  realtimeAccessToken: "signed-realtime-token",
});
```

Cover network exceptions, timeouts, and HTTP 5xx as ambiguous; provider 4xx and malformed successful responses as definitive. Assert an ambiguous reservation stays `PENDING_PAYMENT` / `PENDING` with its connector `OCCUPIED`.

- [ ] **Step 2: Run focused tests and observe failure**

Run: `pnpm --filter @charge-station/api exec vitest run src/payments/payos.client.spec.ts src/payments/payments.service.spec.ts`

Expected: generic errors are unclassified and all failures currently compensate.

- [ ] **Step 3: Implement typed classification and reconciliation**

```ts
if (error instanceof PayosPaymentLinkDefinitiveError) {
  await this.failPaymentLinkReservation(reservation.paymentId);
  throw error;
}
const reconciled = await this.tryReconcilePaymentLink(reservation);
return reconciled ?? { paymentPending: true };
```

Classify Axios HTTP 4xx and invalid provider payloads as definitive. Classify transport throws, timeouts, HTTP 5xx, and unknown failures as ambiguous. Do not issue another payment-link POST; use the existing lookup endpoint and persist a recovered link when available.

- [ ] **Step 4: Make authorized payment-link polling explicit**

Return `{ provider: "PAYOS", paymentPending: true }` from `getPaymentLink` when reconciliation remains ambiguous. Do not change `OrdersController` authorization or gateway token validation.

- [ ] **Step 5: Run focused unit tests**

Run: `pnpm --filter @charge-station/api exec vitest run src/payments/payos.client.spec.ts src/payments/payments.service.spec.ts src/orders/orders.controller.spec.ts`

Expected: all classification, compensation, pending capability, and authorization tests pass.

### Task 3: Prove ambiguous webhooks reconcile in API and PostgreSQL flows

**Files:**

- Modify: `apps/charge-station-api/src/realtime/charge-boundary.e2e-spec.ts`
- Modify: `apps/charge-station-api/src/payments/payments.postgres-spec.ts`

**Interfaces:**

- Consumes: pending response capability, authorized payment-link polling, and signed `POST /payments/payos/webhook`.
- Verifies: `PaymentTransactionStatus.PENDING` can move to `PAID` after an ambiguous create result.

- [ ] **Step 1: Write failing API e2e and PostgreSQL tests**

```ts
expect(created.body.payment).toEqual({
  provider: "PAYOS",
  paymentPending: true,
});
await request(app.getHttpServer())
  .get(`/orders/${created.body.orderId}/payment-link`)
  .set("authorization", `Bearer ${created.body.realtimeAccessToken}`)
  .expect(200, { provider: "PAYOS", paymentPending: true });
```

Then send a valid signed PAID webhook and assert one session and one start command exist. In PostgreSQL, assert the original connector remains occupied before that webhook. Keep the definitive-rejection test and assert it releases the connector.

- [ ] **Step 2: Run focused integration tests and observe failure**

Run: `pnpm --filter @charge-station/api test:e2e -- src/realtime/charge-boundary.e2e-spec.ts`

Run: `pnpm --filter @charge-station/api test:postgres -- src/payments/payments.postgres-spec.ts`

Expected: current behavior marks the ambiguous payment failed and the webhook is idempotently ignored.

- [ ] **Step 3: Run the complete API verification matrix**

Run: `pnpm --filter @charge-station/contracts build`

Run: `pnpm --filter @charge-station/api test`

Run: `pnpm --filter @charge-station/api test:e2e`

Run: `pnpm --filter @charge-station/api test:postgres`

Run: `pnpm --filter @charge-station/api build`

Run: `pnpm --filter @charge-station/api lint`

Expected: all requested API unit, e2e, PostgreSQL, build, and lint checks pass.

- [ ] **Step 4: Commit the scoped implementation**

```bash
git add apps/charge-station-api docs/superpowers/plans/2026-09-08-p1-ambiguous-paths.md
git commit -m "fix: preserve ambiguous payment and IoT command paths"
```

## Self-Review

- Dispatcher task covers post-payment and retry-start caller conversion, bounded health probes, no pre-dispatch retry mutation, and one dispatch after health recovery.
- PayOS task covers typed classification, definitive compensation, ambiguous reservation retention, lookup reconciliation, pending capability, and protected polling.
- Integration task covers signed webhook acceptance after ambiguity, PostgreSQL state persistence, requested API verification, and no frontend edits.
- The plan contains no placeholders and uses the same `dispatchWhenIotReady`, typed PayOS error, and `paymentPending` names throughout.
