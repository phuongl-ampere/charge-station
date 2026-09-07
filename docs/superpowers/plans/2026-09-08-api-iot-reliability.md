# API and IoT Reliability Implementation Plan

> For agentic workers: use a task-by-task execution workflow. Steps use checkbox syntax.

**Goal:** Close the final API, mock-IoT, Compose, test, and documentation reliability findings without changing the web application.

**Architecture:** The API persists business state before external service/provider calls. Command recovery begins only after the API listener is ready. Mock IoT terminal events retain an event object and retry state in device runtime memory until the API acknowledges delivery. PayOS link creation becomes reserve, provider call, persist, then reconcile-if-needed.

**Tech Stack:** NestJS 11, TypeORM, PostgreSQL, Axios, Vitest, Supertest, Docker Compose, pnpm.

## Global Constraints

- [x] Modify API, IoT service, Compose, tests, and docs only; do not modify apps/web.
- [x] Add each behavior with a focused failing test before production code.
- [x] Preserve PayOS HMAC validation, service-token protection, and local-only IoT callback validation.
- [x] A START command with a non-canonical ISO UTC expiry or expiry less than or equal to now must never energize a connector.
- [x] Terminal mock IoT events retry with a stable event ID until a successful API response; retry timers must not keep test processes alive.
- [x] Finish with API unit/e2e/PostgreSQL, IoT unit/e2e, builds, and docker compose config/build.

## File Structure

- apps/charge-station-api/src/main.ts: starts recovery after app.listen resolves.
- apps/charge-station-api/src/iot/command-dispatcher.service.ts: nonblocking recovery and definitive expiry settlement.
- apps/charge-station-api/src/charging/charging.service.ts: retry a terminally failed STOP while retaining history.
- apps/charge-station-api/src/payments/payments.service.ts: reserve/provider/persist/reconcile payment link lifecycle.
- apps/charge-station-api/src/payments/payos.client.ts: fetches an existing provider link by order code.
- apps/charge-station-api/src/orders/orders.controller.ts: exposes capability-authorized payment link recovery.
- apps/iot-service/src/devices/device-state.service.ts: owns terminal delivery retry records and cleanup.
- apps/iot-service/src/commands/commands.service.ts: rejects expired starts and schedules terminal delivery.
- docker-compose.yml and docs/local-development.md: record post-ready API recovery and retry operation.

---

### Task 1: Post-listen recovery and expired START settlement

**Files:**

- Modify: apps/charge-station-api/src/main.ts
- Modify: apps/charge-station-api/src/iot/command-dispatcher.service.ts
- Test: apps/charge-station-api/src/iot/command-dispatcher.service.spec.ts
- Test: apps/charge-station-api/src/main.spec.ts

**Interfaces:**

- CommandDispatcherService.dispatchPendingAfterReady(): void schedules and logs recovery work.
- CommandDispatcherService.dispatch(commandId: string): Promise<void> remains the durable per-command path.

- [x] **Step 1: Write failing tests**

```ts
it("does not wait for pending recovery during bootstrap", async () => {
  const recover = vi.fn(() => new Promise<void>(() => undefined));
  const service = createDispatcher({ recover });
  service.dispatchPendingAfterReady();
  expect(recover).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(recover).toHaveBeenCalledOnce();
});

it("settles an expired pending START without calling IoT", async () => {
  const command = createCommand({
    payload: { ...payload, expiresAt: "2026-09-08T10:00:00.000Z" },
  });
  await expect(service.dispatch(command.commandId)).rejects.toThrow("expired");
  expect(iotClient.start).not.toHaveBeenCalled();
  expect(command.status).toBe(DeviceCommandStatus.FAILED);
  expect(command.session.status).toBe(ChargingSessionStatus.START_FAILED);
  expect(command.session.connector.status).toBe(ConnectorStatus.AVAILABLE);
});
```

- [x] **Step 2: Run the tests and confirm they fail**

Run: pnpm --filter @charge-station/api test -- command-dispatcher.service.spec.ts

Expected: FAIL because bootstrap awaits recovery and expiry has no definitive failure path.

- [x] **Step 3: Implement the minimal behavior**

```ts
await app.listen(Number(process.env.PORT ?? 4000));
app.get(CommandDispatcherService).dispatchPendingAfterReady();

dispatchPendingAfterReady(): void {
  queueMicrotask(() => {
    void this.dispatchPending().catch((error: unknown) => this.logPendingDispatchError(error));
  });
}
```

Validate expiry with an exact Date.prototype.toISOString round trip and require it to be later than Date.now(). Send expired persisted START records through markDefinitiveStartFailure under the existing session and connector locks.

- [x] **Step 4: Re-run focused verification**

Run: pnpm --filter @charge-station/api test -- command-dispatcher.service.spec.ts

Expected: PASS.

### Task 2: IoT expiry rejection and terminal event retry

**Files:**

- Modify: apps/iot-service/src/devices/device-state.service.ts
- Modify: apps/iot-service/src/commands/commands.service.ts
- Test: apps/iot-service/src/commands/commands.service.spec.ts
- Test: apps/iot-service/src/commands/commands.e2e-spec.ts
- Test: apps/charge-station-api/test/charge-lifecycle.e2e-spec.ts

**Interfaces:**

- DeviceStateService retains a PendingTerminalDelivery for each terminal event.
- CommandsService rejects an expired START before state creation.
- STOPPED, COMMAND_FAILED, and DEVICE_OFFLINE reuse their initial event ID for retries.

- [x] **Step 1: Write failing tests**

```ts
it("rejects malformed and expired starts before runtime state exists", async () => {
  const response = await service.start({
    ...command,
    expiresAt: "2026-09-08T10:00:00.000Z",
  });
  expect(response).toMatchObject({ accepted: false, status: "REJECTED" });
  expect(deviceState.getCommand(command.commandId)).toBeUndefined();
});

it("retries lost STOPPED delivery with the same event ID", async () => {
  eventClient.post.mockRejectedValueOnce(new Error("lost"));
  eventClient.post.mockResolvedValueOnce(undefined);
  await service.start(commandWithDuration(1));
  await vi.advanceTimersByTimeAsync(1_100);
  const first = callsOfType(eventClient, "STOPPED")[0];
  await vi.advanceTimersByTimeAsync(100);
  expect(callsOfType(eventClient, "STOPPED")[1].eventId).toBe(first.eventId);
});
```

- [x] **Step 2: Run the tests and confirm they fail**

Run: pnpm --filter @charge-station/iot-service test -- commands.service.spec.ts

Expected: FAIL because expiry is not validated and failed terminal delivery is only logged.

- [x] **Step 3: Implement the minimal behavior**

```ts
interface PendingTerminalDelivery {
  event: DeviceEvent;
  retryCount: number;
  retryTimer?: ReturnType<typeof setTimeout>;
}

const TERMINAL_RETRY_DELAYS_MS = [100, 500, 1_000] as const;
```

Store the original event object in DeviceRuntimeState. Retry the same object with capped backoff until eventClient.post resolves. Clear retry timers on acknowledgement and shutdown; unref real timers when available.

- [x] **Step 4: Re-run focused verification**

Run: pnpm --filter @charge-station/iot-service test -- commands.service.spec.ts

Run: pnpm --filter @charge-station/iot-service test:e2e -- commands.e2e-spec.ts

Expected: PASS with no open timer handles.

### Task 3: Retry a failed STOP while preserving history

**Files:**

- Modify: apps/charge-station-api/src/charging/charging.service.ts
- Test: apps/charge-station-api/src/charging/charging.service.spec.ts
- Test: apps/charge-station-api/src/charging/charging.postgres-spec.ts
- Test: apps/charge-station-api/src/charging/charging.controller.spec.ts

**Interfaces:**

- POST /sessions/:id/stop remains capability-authorized.
- When a session is STOPPING and no PENDING, SENT, or ACCEPTED STOP exists, create one new PENDING STOP command.
- The new command copies the latest failed STOP reason and never mutates the failed row.

- [x] **Step 1: Write the failing tests**

```ts
it("retries a failed STOP while retaining audit history and STOPPING state", async () => {
  const failed = await persistStop({
    status: DeviceCommandStatus.FAILED,
    reason: "SYSTEM_REQUESTED",
  });
  await expect(service.stopSession(session.id)).resolves.toEqual({
    accepted: true,
  });
  const stops = await findStops(session.id);
  expect(stops).toContainEqual(
    expect.objectContaining({ commandId: failed.commandId, status: "FAILED" }),
  );
  expect(stops).toContainEqual(
    expect.objectContaining({
      status: "PENDING",
      payload: { sessionId: session.id, reason: "SYSTEM_REQUESTED" },
    }),
  );
  expect((await findSession(session.id)).status).toBe(
    ChargingSessionStatus.STOPPING,
  );
});
```

- [x] **Step 2: Run the tests and confirm they fail**

Run: pnpm --filter @charge-station/api test -- charging.service.spec.ts charging.controller.spec.ts

Run: pnpm --filter @charge-station/api test:postgres -- charging.postgres-spec.ts

Expected: FAIL because STOPPING is rejected after the prior STOP transitions to FAILED.

- [x] **Step 3: Implement the minimal behavior**

Permit STOPPING after the active-command lookup has found no active STOP. Query the latest failed STOP, validate its stored reason against USER_REQUESTED or SYSTEM_REQUESTED, and use it in the new command. Keep the existing partial index unchanged because it only restricts active rows.

- [x] **Step 4: Re-run focused verification**

Run: pnpm --filter @charge-station/api test -- charging.service.spec.ts charging.controller.spec.ts

Run: pnpm --filter @charge-station/api test:postgres -- charging.postgres-spec.ts

Expected: PASS.

### Task 4: Two-phase PayOS link creation and recovery

**Files:**

- Modify: apps/charge-station-api/src/payments/payos.client.ts
- Modify: apps/charge-station-api/src/payments/payments.service.ts
- Modify: apps/charge-station-api/src/orders/orders.controller.ts
- Modify: apps/charge-station-api/src/orders/orders.module.ts
- Test: apps/charge-station-api/src/payments/payments.service.spec.ts
- Test: apps/charge-station-api/src/payments/payos.client.spec.ts
- Test: apps/charge-station-api/test/charge-lifecycle.e2e-spec.ts
- Test: apps/charge-station-api/src/orders/orders.controller.spec.ts

**Interfaces:**

- PayosClient.getPaymentLinkInfo(orderCode: number): Promise<PaymentLink>.
- PaymentsService.getPaymentLink(orderId: string): Promise<{ provider: 'PAYOS'; checkoutUrl: string }>.
- GET /orders/:id/payment-link authorizes through ChargeGateway.authorizeOrder.

- [x] **Step 1: Write failing tests**

```ts
it("does not invoke PayOS while its manager transaction is active", async () => {
  let inTransaction = false;
  dataSource.transaction.mockImplementation(async (callback) => {
    inTransaction = true;
    try {
      return await callback(manager);
    } finally {
      inTransaction = false;
    }
  });
  payosClient.createPaymentLink.mockImplementation(async () => {
    expect(inTransaction).toBe(false);
    return { paymentLinkId: "pl_1", checkoutUrl: "https://pay.example/1" };
  });
  await service.createOrder(input);
});

it("recovers a provider link after its first persistence transaction fails", async () => {
  await service.createOrder(input);
  await expect(service.getPaymentLink(orderId)).resolves.toEqual({
    provider: "PAYOS",
    checkoutUrl: "https://pay.example/1",
  });
  expect(payosClient.createPaymentLink).toHaveBeenCalledTimes(1);
  expect(payosClient.getPaymentLinkInfo).toHaveBeenCalledWith(orderCode);
});
```

- [x] **Step 2: Run the tests and confirm they fail**

Run: pnpm --filter @charge-station/api test -- payments.service.spec.ts payos.client.spec.ts orders.controller.spec.ts

Expected: FAIL because createPaymentLink runs inside the reservation transaction and no recovery endpoint exists.

- [x] **Step 3: Implement the minimal behavior**

```ts
const reservation = await this.reserveOrder(input);
const link = await this.payosClient.createPaymentLink(
  reservation.paymentLinkInput,
);
try {
  await this.persistPaymentLink(reservation.paymentId, link);
} catch (error) {
  this.logger.error("PayOS link persistence requires reconciliation", error);
}
return this.createOrderResponse(reservation, link.checkoutUrl);
```

reserveOrder atomically locks and occupies the connector, creates Order and PaymentTransaction with null link fields, and commits. createPaymentLink executes after that commit. persistPaymentLink locks only its PaymentTransaction and writes the provider ID and URL. getPaymentLink returns a stored URL without network traffic; otherwise it calls GET /v2/payment-requests/{orderCode} through PayosClient, then upserts the returned URL in a short transaction. The mock client returns the deterministic local URL. Never call createPaymentLink while reconciling.

- [x] **Step 4: Re-run focused verification**

Run: pnpm --filter @charge-station/api test -- payments.service.spec.ts payos.client.spec.ts orders.controller.spec.ts

Run: pnpm --filter @charge-station/api test:e2e -- payments.e2e-spec.ts

Expected: PASS.

### Task 5: Cross-service proof, Compose, and docs

**Files:**

- Modify: apps/charge-station-api/test/charge-lifecycle.e2e-spec.ts
- Modify: docker-compose.yml
- Modify: README.md
- Modify: docs/local-development.md

**Interfaces:**

- IoT remains dependent on the API health check in Compose.
- API can report healthy before delayed pending-command dispatch begins.
- Retried STOPPED delivery eventually causes API terminal state and connector release.

- [x] **Step 1: Write failing integration assertions**

```ts
it("retries a lost STOPPED callback and releases the connector after API acknowledgement", async () => {
  failFirstStoppedCallback();
  await completePaidLifecycle();
  await eventually(
    () => readSessionStatus(),
    (status) => status === ChargingSessionStatus.COMPLETED,
  );
  expect(await readConnectorStatus()).toBe(ConnectorStatus.AVAILABLE);
  expect(stoppedCallbackIds()).toEqual([sameEventId, sameEventId]);
});
```

- [x] **Step 2: Run the integration test and confirm it fails**

Run: pnpm --filter @charge-station/api test:e2e -- charge-lifecycle.e2e-spec.ts

Expected: FAIL because the first lost STOPPED event is never retried.

- [x] **Step 3: Update operational docs**

Document that the API listener becomes healthy before background command recovery, that IoT waits on API health in Compose, that terminal mock events retry with bounded backoff, and that GET /orders/:id/payment-link is capability-authorized reconciliation for an accepted PayOS link whose first database persistence failed.

- [x] **Step 4: Run the full verification set**

Run: pnpm --filter @charge-station/api test

Run: pnpm --filter @charge-station/api test:e2e

Run: pnpm --filter @charge-station/api test:postgres

Run: pnpm --filter @charge-station/iot-service test

Run: pnpm --filter @charge-station/iot-service test:e2e

Run: pnpm --filter @charge-station/api build

Run: pnpm --filter @charge-station/iot-service build

Run: docker compose config

Run: docker compose build charge-station-api iot-service

Expected: all commands exit successfully.

- [x] **Step 5: Commit**

```sh
git add apps/charge-station-api apps/iot-service docker-compose.yml README.md docs
git commit -m "fix: harden API and IoT reliability"
```
