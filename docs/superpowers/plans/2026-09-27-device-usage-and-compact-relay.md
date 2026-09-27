# Device Usage and Compact Relay Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace device hold with an explicit in-use business state and make independent relay demo controls compact.

**Architecture:** Rename the persisted station column through a new migration, expose `inUse` via occupy/release endpoints, and reject only new payment reservations. The dashboard makes usage operationally prominent while placing relay controls in a closed native disclosure.

**Tech Stack:** NestJS, TypeORM/PostgreSQL, Vitest, Next.js/React, Testing Library, CSS.

## Global Constraints

- `inUse` is an operator-controlled customer-usage state; it blocks new payment reservations only.
- Existing sessions, telemetry, and all relay demo controls remain available while in use.
- No runtime `deviceHold`, `held`, `/hold`, or hold-copy remains.
- Relay demo keeps four relays and the existing 15-minute default ON duration.
- Preserve unrelated `.env.example`, `iot-core/`, and Python-cache changes on `main`.

---

### Task 1: Migrate and expose usage state

**Files:**
- Create: `apps/charge-station-api/src/database/migrations/012-device-usage.ts`
- Create: `apps/charge-station-api/src/database/migrations/012-device-usage.spec.ts`
- Modify: `apps/charge-station-api/src/database/data-source.ts`
- Modify: `apps/charge-station-api/src/admin/devices.service.ts`
- Modify: `apps/charge-station-api/src/admin/devices.controller.ts`
- Test: `apps/charge-station-api/src/admin/devices.service.spec.ts`
- Test: `apps/charge-station-api/src/admin/devices.controller.spec.ts`

**Interfaces:**
- Produces `Station.deviceInUse: boolean`, `DeviceListItem.inUse: boolean`, `DevicesService.setInUse(deviceId, inUse)`, `POST /admin/devices/:deviceId/occupy`, and `POST /admin/devices/:deviceId/release`.

- [ ] **Step 1: Write failing API and migration tests**

```ts
it("renames the persisted hold column to device usage", async () => {
  const query = vi.fn().mockResolvedValue([]);
  await new RenameDeviceHoldToDeviceUsage().up({ query } as unknown as QueryRunner);
  expect(query).toHaveBeenCalledWith(
    "ALTER TABLE stations RENAME COLUMN device_hold TO device_in_use",
  );
});

it("marks a device in use while allowing its relay demo to turn on", async () => {
  await expect(service.setInUse("core-device-1", true)).resolves.toEqual({
    deviceId: "core-device-1", inUse: true,
  });
  await service.controlRelay("core-device-1", "relay-4", {
    enabled: true, durationSeconds: 60,
  });
  expect(core.setRelay).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @charge-station/api test -- devices.service.spec.ts devices.controller.spec.ts 012-device-usage.spec.ts`

Expected: FAIL because the migration, `setInUse`, `inUse`, and occupy action do not exist; old code rejects a relay command while held.

- [ ] **Step 3: Implement minimal data and endpoint rename**

```ts
export class RenameDeviceHoldToDeviceUsage implements MigrationInterface {
  name = "RenameDeviceHoldToDeviceUsage20260927010000";
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE stations RENAME COLUMN device_hold TO device_in_use",
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE stations RENAME COLUMN device_in_use TO device_hold",
    );
  }
}
```

Change the entity to `@Column({ name: "device_in_use", type: "boolean", default: false }) deviceInUse!: boolean;`, append migration 012 to `migrations`, rename `held`/`setHold` to `inUse`/`setInUse`, and remove the `station.deviceHold && input.enabled` guard from `controlRelay`.

```ts
@Post(":deviceId/occupy")
occupy(@Param("deviceId") deviceId: string) {
  return this.devices.setInUse(deviceId, true);
}

@Post(":deviceId/release")
release(@Param("deviceId") deviceId: string) {
  return this.devices.setInUse(deviceId, false);
}
```

- [ ] **Step 4: Run GREEN and commit**

Run: `pnpm --filter @charge-station/api test -- devices.service.spec.ts devices.controller.spec.ts 012-device-usage.spec.ts`

Expected: PASS.

```bash
git add apps/charge-station-api/src/database apps/charge-station-api/src/admin
git commit -m "feat: separate device usage from relay controls"
```

### Task 2: Tie payment admission to usage state only

**Files:**
- Modify: `apps/charge-station-api/src/payments/payments.service.ts`
- Test: `apps/charge-station-api/src/payments/payments.service.spec.ts`

**Interfaces:**
- Consumes `Station.deviceInUse`.
- Produces `BadRequestException("Station device is in use")` for a new reservation on an in-use device.

- [ ] **Step 1: Write failing reservation test**

```ts
it("rejects a new order when the linked station device is in use", async () => {
  const connector = {
    id: randomUUID(), code: "ST01-C01", status: "AVAILABLE",
    station: { deviceInUse: true },
    pricingPlan: { hourlyPriceVnd: 5000, allowedDurationsMinutes: [60] },
  } as Connector;
  await expect(
    service.createOrder({ connectorCode: connector.code, durationMinutes: 60 }),
  ).rejects.toThrow("Station device is in use");
  expect(connectorRepository.save).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run RED, implement, run GREEN**

Run: `pnpm --filter @charge-station/api test -- payments.service.spec.ts`

Expected before implementation: FAIL because the code reads `deviceHold`.

Implement:

```ts
if (connector.station?.deviceInUse) {
  throw new BadRequestException("Station device is in use");
}
```

Expected after implementation: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/charge-station-api/src/payments/payments.service.ts apps/charge-station-api/src/payments/payments.service.spec.ts
git commit -m "feat: use device usage state for payment admission"
```

### Task 3: Render operational usage and a compact relay demo

**Files:**
- Modify: `apps/web/lib/api.ts`
- Test: `apps/web/lib/api.test.ts`
- Modify: `apps/web/components/AdminDashboard.tsx`
- Test: `apps/web/components/AdminDashboard.test.tsx`
- Modify: `apps/web/app/globals.css`

**Interfaces:**
- Consumes `AdminDevice.inUse`, `/occupy`, and `/release` from Task 1.
- Produces `AdminApi.setDeviceUsage(deviceId, inUse, accessToken)`, a Usage column, and a closed relay-demo disclosure.

- [ ] **Step 1: Write failing web tests**

```tsx
expect(screen.getByText("Available")).toBeVisible();
expect(screen.getByRole("button", { name: "Mark device in use" })).toBeVisible();
expect(screen.queryByRole("button", { name: "Turn on relay-1" })).toBeNull();
await user.click(screen.getByText("Relay demo"));
expect(screen.getByRole("button", { name: "Turn on relay-1" })).toBeVisible();
```

The API test expects `POST /admin/devices/device-1/occupy` and `{ deviceId: "device-1", inUse: true }`.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @charge-station/web test -- api.test.ts AdminDashboard.test.tsx`

Expected: FAIL because the current API uses hold and relay controls are always visible.

- [ ] **Step 3: Implement the client and UI changes**

```ts
setDeviceUsage(
  deviceId: string,
  inUse: boolean,
  accessToken: string,
): Promise<{ deviceId: string; inUse: boolean }>;
```

Request `${base}/admin/devices/${encodeURIComponent(deviceId)}/${inUse ? "occupy" : "release"}`. Rename local hold state to usage state and use **Usage**, **In use**, **Available**, **Mark device in use**, and **Release device** copy.

```tsx
<details className="admin-relay-demo">
  <summary>Relay demo</summary>
  <p>Technical controls only. ON runs for 15 minutes by default.</p>
  <div className="admin-relay-list">{relayRows}</div>
</details>
```

Use compact `.admin-relay-demo`, `.admin-relay-list`, and `.admin-relay-row` CSS. Do not use `inUse` in relay button `disabled` conditions.

- [ ] **Step 4: Run GREEN and commit**

Run: `pnpm --filter @charge-station/web test -- api.test.ts AdminDashboard.test.tsx`

Expected: PASS.

```bash
git add apps/web/lib/api.ts apps/web/lib/api.test.ts apps/web/components/AdminDashboard.tsx apps/web/components/AdminDashboard.test.tsx apps/web/app/globals.css
git commit -m "feat: clarify device usage and compact relay demo"
```

### Task 4: Verify end to end

**Files:**
- Modify: no files unless a failing verification identifies a defect.

- [ ] **Step 1: Run package tests and build**

```bash
pnpm --filter @charge-station/api test
pnpm --filter @charge-station/web test
pnpm --filter @charge-station/contracts test
PYTHONPATH=apps/core-iot-device-simulator python3 -m unittest discover -s apps/core-iot-device-simulator/tests -v
pnpm build
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Verify preview behavior**

At `http://localhost:3100/admin`, open **Device activity**. Verify ST01 usage is independent of charging-session text, occupy blocks a new payment reservation, release reopens reservation, and relay demo is collapsed initially yet remains controllable while in use.

## Plan Self-Review

- Task 1 covers data/API rename and relay independence; Task 2 covers payment admission; Task 3 covers the requested compact UI; Task 4 covers regression and runtime verification.
- `Station.deviceInUse`, `DeviceListItem.inUse`, `setInUse`, `setDeviceUsage`, `/occupy`, and `/release` are consistent in every task.
