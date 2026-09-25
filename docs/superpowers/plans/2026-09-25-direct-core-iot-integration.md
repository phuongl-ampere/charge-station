# Direct Core IoT Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Remove the IoT mock runtime, control the Core IoT device from Charge Station API, run a real MQTT device simulator, and show electrical telemetry in Admin.

**Architecture:** A CoreIotClient provider creates and polls Core two-way setRelay commands. A CoreTelemetryMonitor reads Core telemetry and submits existing DeviceEventsService events. A separate MQTT simulator owns the relay and its automatic timer.

**Tech Stack:** NestJS, TypeORM/PostgreSQL, TypeScript/Vitest, Next.js/React, Docker Compose, Python 3.12, Paho MQTT, Core IoT REST/MQTT APIs.

## Global Constraints

- Do not edit Core IoT source, binary, or database.
- Never commit Core access tokens, device tokens, cookie jars, or local environment files.
- Do not run docker compose down -v.
- station.deviceId is the Core device ID and relay-1 is the default mapped relay.
- HTTP 202 is not device success: start and stop require a successful two-way response.
- The simulator owns timer expiry; Charge Station observes it through Core telemetry.
- DeviceEventsService remains the sole path for persisted charging session state transitions.
- Local PayOS mock can remain; it is not IoT mocking.

---

### Task 1: Add a tested Core IoT REST client

**Files:**
- Create: apps/charge-station-api/src/iot/core-iot.client.ts
- Create: apps/charge-station-api/src/iot/core-iot.client.spec.ts
- Modify: apps/charge-station-api/src/iot/iot.module.ts

**Interfaces:**
- CoreIotClient.setRelay(input): Promise<CoreRelayResult>
- CoreIotClient.latestTelemetry(deviceId): Promise<CoreTelemetry | null>
- Environment: IOT_CORE_PUBLIC_URL, IOT_CORE_ACCESS_TOKEN, IOT_CORE_COMMAND_TIMEOUT_MS, IOT_CORE_COMMAND_POLL_MS

- [ ] **Step 1: Write the failing two-way command test**

~~~
it("submits setRelay as two-way RPC and waits for device response", async () => {
  vi.stubEnv("IOT_CORE_PUBLIC_URL", "http://core.test:18090");
  vi.stubEnv("IOT_CORE_ACCESS_TOKEN", "delegated-token");
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(jsonResponse(202, { id: "core-command", state: "queued" }))
    .mockResolvedValueOnce(jsonResponse(200, {
      id: "core-command", state: "responded",
      response: { ok: true, result: { relayId: "relay-1", enabled: true, remainingSeconds: 3600 } },
    }));

  await expect(new CoreIotClient().setRelay({
    commandId: "charge-command", deviceId: "core-device", relayId: "relay-1",
    enabled: true, durationSeconds: 3600, sessionId: "session-1",
  })).resolves.toEqual({
    commandId: "core-command", relayId: "relay-1", enabled: true, remainingSeconds: 3600,
  });

  expect(fetch).toHaveBeenNthCalledWith(1,
    "http://core.test:18090/api/v1/devices/core-device/commands",
    expect.objectContaining({ headers: expect.objectContaining({
      authorization: "Bearer delegated-token", "idempotency-key": "charge-command",
    }) }),
  );
});
~~~

- [ ] **Step 2: Verify red**

Run: pnpm --filter @charge-station/api test -- core-iot.client.spec.ts

Expected: FAIL because CoreIotClient does not exist.

- [ ] **Step 3: Implement the minimal client**

~~~
async setRelay(input: CoreRelayCommand): Promise<CoreRelayResult> {
  const command = await this.request("/api/v1/devices/" + encodeURIComponent(input.deviceId) + "/commands", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": input.commandId },
    body: JSON.stringify({
      method: "setRelay", mode: "two_way",
      params: {
        relayId: input.relayId, enabled: input.enabled,
        ...(input.durationSeconds === undefined ? {} : { durationSeconds: input.durationSeconds }),
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      },
    }),
  });
  return this.waitForRelayResponse(command.id, input);
}
~~~

Implement authenticated requests, bounded polling, and typed errors. Implement latestTelemetry with a recent time window and choose the final item from Core's ascending items array.

- [ ] **Step 4: Write failure and telemetry tests before extending code**

~~~
it("rejects a non-ok two-way response", async () => {
  mockResponded({ ok: false, error: "relay_fault" });
  await expect(client.setRelay(startInput)).rejects.toBeInstanceOf(CoreIotCommandRejectedError);
});

it("returns only the final ascending telemetry item", async () => {
  mockTelemetry([
    sample("2026-09-25T01:00:01.000Z", { voltage_v: 220 }),
    sample("2026-09-25T01:00:02.000Z", { voltage_v: 230.4, power_w: 2350 }),
  ]);
  await expect(client.latestTelemetry("core-device")).resolves.toMatchObject({
    eventAt: "2026-09-25T01:00:02.000Z", voltageV: 230.4, powerW: 2350,
  });
});
~~~

Treat no sample as null. Do not create zero values for missing measurements. Treat Core/network timeout as transport error and rejected/invalid response as command rejection.

- [ ] **Step 5: Register and export CoreIotClient**

~~~
@Module({
  providers: [CoreIotClient, CommandDispatcherService, DeviceEventsService],
  exports: [CommandDispatcherService, CoreIotClient],
})
export class IotModule {}
~~~

- [ ] **Step 6: Verify green and commit**

Run: pnpm --filter @charge-station/api test -- core-iot.client.spec.ts && pnpm --filter @charge-station/api lint

Expected: focused test passes and zero TypeScript errors.

~~~
git add apps/charge-station-api/src/iot/core-iot.client.ts apps/charge-station-api/src/iot/core-iot.client.spec.ts apps/charge-station-api/src/iot/iot.module.ts
git commit -m "feat: add direct Core IoT client"
~~~

### Task 2: Dispatch persisted start and stop commands through Core

**Files:**
- Modify: packages/contracts/src/iot.ts
- Modify: apps/charge-station-api/src/iot/command-dispatcher.service.ts
- Modify: apps/charge-station-api/src/iot/command-dispatcher.service.spec.ts
- Modify: apps/charge-station-api/src/charging/charging.service.ts
- Modify: apps/charge-station-api/src/charging/charging.controller.spec.ts
- Delete: apps/charge-station-api/src/iot/iot-service.client.ts
- Delete: apps/charge-station-api/src/iot/iot-service.client.spec.ts

**Interfaces:**
- StartChargingCommand adds deviceId and relayId.
- StopChargingCommand adds deviceId, relayId, and startCommandId.
- CommandDispatcherService consumes CoreIotClient and DeviceEventsService.

- [ ] **Step 1: Write the failing start test**

~~~
it("emits accepted then running only after Core confirms relay on", async () => {
  core.setRelay.mockResolvedValue({
    commandId: "core-1", relayId: "relay-1", enabled: true, remainingSeconds: 3600,
  });

  await dispatcher.dispatch("start-command");

  expect(core.setRelay).toHaveBeenCalledWith(expect.objectContaining({
    enabled: true, durationSeconds: 3600, deviceId: "core-device",
  }));
  expect(events.handle.mock.calls.map(([event]) => event.type)).toEqual([
    "COMMAND_ACCEPTED", "RUNNING",
  ]);
});
~~~

- [ ] **Step 2: Verify red**

Run: pnpm --filter @charge-station/api test -- command-dispatcher.service.spec.ts

Expected: FAIL because the dispatcher calls IotServiceClient.

- [ ] **Step 3: Expand command contracts and stop payload**

~~~
export interface StartChargingCommand {
  commandId: string; sessionId: string; stationCode: string; connectorCode: string;
  deviceId: string; relayId: string; durationSeconds: number; expiresAt: string; configVersion: number;
}
export interface StopChargingCommand {
  commandId: string; sessionId: string; deviceId: string; relayId: string;
  startCommandId: string; reason: "USER_REQUESTED" | "SYSTEM_REQUESTED";
}
~~~

When ChargingService creates a stop command, load the original start command and persist deviceId, relayId, and original start command ID. Reject a missing mapping rather than selecting a device implicitly.

- [ ] **Step 4: Replace mock transport with Core and in-process events**

~~~
private async sendStart(command: StartChargingCommand): Promise<void> {
  await this.coreIotClient.setRelay({ ...command, enabled: true });
  await this.deviceEventsService.handle(eventFor(command, "COMMAND_ACCEPTED", { relayState: "ON" }));
  await this.deviceEventsService.handle(eventFor(command, "RUNNING", {
    relayState: "ON", remainingSeconds: command.durationSeconds,
  }));
}

private async sendStop(command: StopChargingCommand): Promise<void> {
  await this.coreIotClient.setRelay({ ...command, enabled: false });
  await this.deviceEventsService.handle(eventFor(
    { ...command, commandId: command.startCommandId },
    "STOPPED",
    { reason: command.reason, relayState: "OFF" },
  ));
}
~~~

Keep current retry semantics for transport failures and current definitive start failure behavior for Core rejection. eventFor must use persisted connector code and original start command ID.

- [ ] **Step 5: Write stop-correlation and rejection tests**

~~~
it("correlates successful stop with original start command", async () => {
  await dispatcher.dispatch("stop-command");
  expect(events.handle).toHaveBeenCalledWith(
    expect.objectContaining({ type: "STOPPED", commandId: "start-command" }),
  );
});

it("does not emit running if Core rejects setRelay", async () => {
  core.setRelay.mockRejectedValue(new CoreIotCommandRejectedError("relay_fault"));
  await expect(dispatcher.dispatch("start-command")).rejects.toThrow("relay_fault");
  expect(events.handle).not.toHaveBeenCalledWith(expect.objectContaining({ type: "RUNNING" }));
});
~~~

- [ ] **Step 6: Remove mock client, verify, and commit**

Run: pnpm --filter @charge-station/api test -- command-dispatcher.service.spec.ts charging.controller.spec.ts && pnpm --filter @charge-station/contracts test

Expected: affected suites pass and rg -n "IotServiceClient" apps/charge-station-api returns no output.

~~~
git add packages/contracts/src/iot.ts apps/charge-station-api/src/iot/command-dispatcher.service.ts apps/charge-station-api/src/iot/command-dispatcher.service.spec.ts apps/charge-station-api/src/charging
git rm apps/charge-station-api/src/iot/iot-service.client.ts apps/charge-station-api/src/iot/iot-service.client.spec.ts
git commit -m "feat: dispatch charging relays through Core IoT"
~~~

### Task 3: Convert Core telemetry into lifecycle events

**Files:**
- Create: apps/charge-station-api/src/iot/core-telemetry-monitor.service.ts
- Create: apps/charge-station-api/src/iot/core-telemetry-monitor.service.spec.ts
- Modify: apps/charge-station-api/src/iot/iot.module.ts
- Modify: apps/charge-station-api/src/main.ts

**Interfaces:**
- CoreTelemetryMonitor.start(), stop(), and pollOnce().
- It queries active sessions plus original START_CHARGING commands from PostgreSQL.
- It calls DeviceEventsService.handle with HEARTBEAT, STOPPED, or DEVICE_OFFLINE.

- [ ] **Step 1: Write failing expiry test**

~~~
it("emits timer-expired stop from matching relay-off telemetry", async () => {
  repository.activeStarts.mockResolvedValue([
    activeStart("session-1", "start-command", "core-device"),
  ]);
  core.latestTelemetry.mockResolvedValue({
    eventAt: "2026-09-25T01:00:05.000Z", relayState: false,
    sessionId: "session-1", lastStopReason: "TIMER_EXPIRED", remainingSeconds: 0,
  });

  await monitor.pollOnce();

  expect(events.handle).toHaveBeenCalledWith(expect.objectContaining({
    type: "STOPPED", commandId: "start-command",
    payload: expect.objectContaining({ reason: "TIMER_EXPIRED" }),
  }));
});
~~~

- [ ] **Step 2: Verify red**

Run: pnpm --filter @charge-station/api test -- core-telemetry-monitor.service.spec.ts

Expected: FAIL because CoreTelemetryMonitor does not exist.

- [ ] **Step 3: Implement a database-backed poll**

~~~
async pollOnce(): Promise<void> {
  for (const start of await this.activeStartCommands()) {
    const sample = await this.coreIotClient.latestTelemetry(start.deviceId);
    if (!sample || sample.eventAt <= start.lastDeviceEventAt) continue;
    if (sample.sessionId !== start.sessionId) continue;

    if (sample.relayState) await this.events.handle(heartbeatEvent(start, sample));
    else if (sample.lastStopReason === "TIMER_EXPIRED") {
      await this.events.handle(stoppedEvent(start, sample));
    }
  }
}
~~~

Obtain database state on each poll so a process restart recovers without a separate runtime state file. Handle Core failures per device.

- [ ] **Step 4: Write stale and duplicate tests**

~~~
it("emits DEVICE_OFFLINE once for stale telemetry", async () => {
  core.latestTelemetry.mockResolvedValue(staleSample());
  await monitor.pollOnce();
  expect(events.handle).toHaveBeenCalledWith(expect.objectContaining({ type: "DEVICE_OFFLINE" }));
});

it("skips sample no newer than lastDeviceEventAt", async () => {
  repository.activeStarts.mockResolvedValue([activeStartWithLastEvent("2026-09-25T01:00:05.000Z")]);
  core.latestTelemetry.mockResolvedValue(sampleAt("2026-09-25T01:00:05.000Z"));
  await monitor.pollOnce();
  expect(events.handle).not.toHaveBeenCalled();
});
~~~

- [ ] **Step 5: Start after the HTTP listener, then verify and commit**

~~~
await app.listen(Number(process.env.PORT ?? 4000));
app.get(CommandDispatcherService).dispatchPendingAfterReady();
app.get(CoreTelemetryMonitor).start();
~~~

Use positive bounded defaults for IOT_CORE_TELEMETRY_POLL_MS and IOT_CORE_TELEMETRY_STALE_MS. Clear the interval on shutdown.

Run: pnpm --filter @charge-station/api test -- core-telemetry-monitor.service.spec.ts device-events.service.spec.ts && pnpm --filter @charge-station/api lint

Expected: all tests pass and zero TypeScript errors.

~~~
git add apps/charge-station-api/src/iot/core-telemetry-monitor.service.ts apps/charge-station-api/src/iot/core-telemetry-monitor.service.spec.ts apps/charge-station-api/src/iot/iot.module.ts apps/charge-station-api/src/main.ts
git commit -m "feat: monitor Core IoT device telemetry"
~~~

### Task 4: Show live meter readings in Admin

**Files:**
- Modify: apps/charge-station-api/src/admin/admin.module.ts
- Modify: apps/charge-station-api/src/admin/admin.service.ts
- Modify: apps/charge-station-api/src/admin/admin.service.spec.ts
- Modify: apps/web/lib/api.ts
- Modify: apps/web/components/AdminDashboard.tsx
- Modify: apps/web/components/AdminDashboard.test.tsx
- Modify: apps/web/app/globals.css

**Interfaces:**
- AdminStation.telemetry is either AVAILABLE with sample fields or UNAVAILABLE.
- AdminService calls CoreIotClient only server-side.

- [ ] **Step 1: Write failing backend telemetry view test**

~~~
it("attaches Core telemetry to mapped station", async () => {
  core.latestTelemetry.mockResolvedValue({
    eventAt: "2026-09-25T01:00:02.000Z", relayState: true,
    voltageV: 230.4, currentA: 10.2, powerW: 2350, energyKwh: 0.0174, remainingSeconds: 3540,
  });

  await expect(admin.getStations()).resolves.toEqual(expect.arrayContaining([
    expect.objectContaining({
      deviceId: "core-device",
      telemetry: expect.objectContaining({ status: "AVAILABLE", voltageV: 230.4, powerW: 2350 }),
    }),
  ]));
});
~~~

- [ ] **Step 2: Verify red**

Run: pnpm --filter @charge-station/api test -- admin.service.spec.ts

Expected: FAIL because station view has no telemetry.

- [ ] **Step 3: Implement tolerant aggregation**

~~~
const telemetry = station.deviceId
  ? await this.coreIotClient.latestTelemetry(station.deviceId).catch(() => null)
  : null;

return {
  id: station.id, code: station.code, name: station.name, deviceId: station.deviceId,
  telemetry: telemetry ? { status: "AVAILABLE", ...telemetry } : { status: "UNAVAILABLE" },
  connectors,
};
~~~

Use Promise.allSettled across stations. Import IotModule into AdminModule. Browser code must receive values only, never Core endpoint or token.

- [ ] **Step 4: Write failing UI tests**

~~~
it("renders voltage current power energy and remaining time", async () => {
  render(<AdminDashboard accessToken="admin" api={apiWithTelemetry()} onLogout={vi.fn()} />);
  expect(await screen.findByText("230.4 V")).toBeInTheDocument();
  expect(screen.getByText("2.35 kW")).toBeInTheDocument();
  expect(screen.getByText("0.017 kWh")).toBeInTheDocument();
});

it("renders unavailable telemetry without false zero values", async () => {
  render(<AdminDashboard accessToken="admin" api={apiWithoutTelemetry()} onLogout={vi.fn()} />);
  expect(await screen.findByText("Telemetry unavailable")).toBeInTheDocument();
  expect(screen.queryByText("0.0 V")).not.toBeInTheDocument();
});
~~~

- [ ] **Step 5: Implement UI, verify, and commit**

Render relay state, sample time, voltage in V, current in A, power in W or kW, energy in kWh, and remaining duration. Add an accessible unavailable status.

Run: pnpm --filter @charge-station/api test -- admin.service.spec.ts && pnpm --filter @charge-station/web test -- AdminDashboard.test.tsx && pnpm --filter @charge-station/web lint

Expected: backend/frontend tests and lint pass.

~~~
git add apps/charge-station-api/src/admin apps/web/lib/api.ts apps/web/components/AdminDashboard.tsx apps/web/components/AdminDashboard.test.tsx apps/web/app/globals.css
git commit -m "feat: show Core IoT telemetry in admin"
~~~

### Task 5: Add real MQTT charge-device simulator

**Files:**
- Create: apps/core-iot-device-simulator/Dockerfile
- Create: apps/core-iot-device-simulator/requirements.txt
- Create: apps/core-iot-device-simulator/src/device_state.py
- Create: apps/core-iot-device-simulator/src/main.py
- Create: apps/core-iot-device-simulator/tests/test_device_state.py

**Interfaces:**
- Reads IOT_CORE_MQTT_HOST, IOT_CORE_MQTT_PORT, IOT_CORE_DEVICE_TOKEN, and IOT_SIMULATOR_TELEMETRY_INTERVAL_SECONDS.
- Uses QoS 1 on Core documented request, response, and telemetry topics.

- [ ] **Step 1: Write failing device-state tests**

~~~
def test_start_relay_owns_duration_and_accumulates_energy() -> None:
    state = ChargeDeviceState(voltage_v=230.0, current_a=10.0)
    state.set_relay(enabled=True, duration_seconds=2, session_id="session-1", now=100.0)
    sample = state.sample(now=101.0)
    assert sample["relay_state"] is True
    assert sample["remaining_seconds"] == 1
    assert sample["power_w"] == 2300.0
    assert sample["energy_kwh"] > 0

def test_expiry_turns_relay_off_locally() -> None:
    state = ChargeDeviceState()
    state.set_relay(enabled=True, duration_seconds=1, session_id="session-1", now=100.0)
    assert state.sample(now=101.1)["relay_state"] is False
    assert state.sample(now=101.1)["last_stop_reason"] == "TIMER_EXPIRED"
~~~

- [ ] **Step 2: Verify red**

Run: PYTHONPATH=apps/core-iot-device-simulator python3 -m unittest discover -s apps/core-iot-device-simulator/tests -v

Expected: FAIL because the simulator module does not exist.

- [ ] **Step 3: Implement relay and meter state**

~~~
def set_relay(self, *, enabled: bool, duration_seconds: int | None,
              session_id: str | None, now: float) -> dict:
    self._advance(now)
    self.relay_state = enabled
    self.session_id = session_id if enabled else None
    self.expires_at = now + duration_seconds if enabled and duration_seconds else None
    self.last_stop_reason = None if enabled else "USER_REQUESTED"
    return self.sample(now)
~~~

Use monotonic time. Power is nonzero only while relay is on and energy accumulates only during on time. Validate duration as positive integer.

- [ ] **Step 4: Write RPC response test, implement MQTT, verify, and commit**

~~~
def test_two_way_set_relay_returns_actual_snapshot() -> None:
    response = handle_rpc(
        {"id": "command-1", "method": "setRelay", "mode": "two_way",
         "params": {"relayId": "relay-1", "enabled": True, "durationSeconds": 60, "sessionId": "session-1"}},
        ChargeDeviceState(), now=100.0,
    )
    assert response["ok"] is True
    assert response["result"]["enabled"] is True
    assert response["result"]["remainingSeconds"] == 60
~~~

Authenticate as username iotd_device_token using the device token password. Subscribe QoS 1 to v1/devices/me/rpc/request/+, reply QoS 1 to matching response topic, and publish QoS 1 telemetry containing relay_state, session_id, remaining_seconds, last_stop_reason, voltage_v, current_a, power_w, energy_kwh. Invalid two-way commands return ok false.

Dockerfile:

~~~
FROM python:3.12-alpine
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY src ./src
CMD ["python", "-m", "src.main"]
~~~

requirements.txt contains exactly paho-mqtt==2.1.0.

Run: PYTHONPATH=apps/core-iot-device-simulator python3 -m unittest discover -s apps/core-iot-device-simulator/tests -v

Expected: simulator tests pass.

~~~
git add apps/core-iot-device-simulator
git commit -m "feat: add Core MQTT charge device simulator"
~~~

### Task 6: Remove mock Compose runtime and prove real E2E

**Files:**
- Modify: docker-compose.yml
- Modify: .env.example
- Modify: apps/charge-station-api/src/database/seed.ts
- Modify: docs/local-development.md
- Delete: apps/iot-service/
- Create: scripts/core-iot-local-e2e.ts
- Create: scripts/core-iot-local-e2e.spec.ts

**Interfaces:**
- API reaches isolated Core through host.docker.internal:18090.
- Simulator reaches MQTT through host.docker.internal:18893.
- Test users and device are created/reused only through isolated Core APIs.

- [ ] **Step 1: Write failing Compose assertion**

~~~
it("runs no iot-service mock and passes Core configuration to API", async () => {
  const compose = await readFile("docker-compose.yml", "utf8");
  expect(compose).not.toContain("iot-service:");
  expect(compose).not.toContain("MOCK_IOT_");
  expect(compose).toContain("IOT_CORE_PUBLIC_URL");
  expect(compose).toContain("core-iot-device-simulator:");
});
~~~

- [ ] **Step 2: Verify red**

Run: pnpm exec vitest run scripts/core-iot-local-e2e.spec.ts

Expected: FAIL because current Compose contains iot-service and MOCK_IOT variables.

- [ ] **Step 3: Replace runtime and refresh ST01 mapping**

Configure API with Core public URL, delegated user token, Core device ID, relay ID, and monitor intervals. Add the simulator sidecar with MQTT host, port, and device token. Remove iot-service, its event-journal volume, MOCK_IOT variables, and obsolete SERVICE_TOKEN. In seedDatabase, update existing ST01.deviceId when IOT_CORE_DEVICE_ID is provided.

- [ ] **Step 4: Build Core API-only provisioning/E2E harness**

~~~
const tenant = await ensureTenant({ slug: "tenant1", password: process.env.CORE_TENANT_PASSWORD! });
const user = await ensureUser(tenant, { username: "user-a", password: process.env.CORE_USER_PASSWORD! });
const device = await ensureDevice(user, { name: "Charge Station Simulator" });
~~~

Use only Core management/public APIs. Reuse existing resources. Keep obtained device token only in a mode-0700 temporary directory, never log it, and refuse any endpoint other than the isolated local Core URL.

- [ ] **Step 5: Execute real flow**

~~~
await waitFor(() => core.latestTelemetry(device.id));
const order = await createAndPayLocalOrder("ST01-C01", 60);
await waitFor(() => sessionStatus(order.sessionId) === "CHARGING");
expect(await core.latestTelemetry(device.id)).toMatchObject({ relayState: true });
await stopSession(order.sessionId);
await waitFor(() => sessionStatus(order.sessionId) === "CANCELLED");
expect(await core.latestTelemetry(device.id)).toMatchObject({ relayState: false });
~~~

- [ ] **Step 6: Verify and commit**

Run: docker compose up -d --build --wait && pnpm --filter @charge-station/api test && pnpm --filter @charge-station/web test && pnpm --filter @charge-station/api lint && pnpm --filter @charge-station/web lint

Expected: no running iot-service; all API/web checks pass; existing volumes remain.

~~~
git add docker-compose.yml .env.example apps/charge-station-api/src/database/seed.ts docs/local-development.md scripts/core-iot-local-e2e.ts scripts/core-iot-local-e2e.spec.ts
git rm -r apps/iot-service
git commit -m "feat: run Charge Station against Core IoT directly"
~~~

### Task 7: Full verification

- [ ] **Step 1: Verify fresh Core telemetry, command response, and session lifecycle**

Run: pnpm tsx scripts/core-iot-local-e2e.ts

Expected: Core command state responded, start reaches CHARGING with nonzero measurements, stop reaches CANCELLED with relay off, and Admin station response includes live telemetry.

- [ ] **Step 2: Verify workspace and no secret leakage**

Run: pnpm build && pnpm test && pnpm lint && git diff --check

Expected: all commands exit zero and Git contains no token file.

- [ ] **Step 3: Commit verification documentation**

~~~
git add docs/local-development.md
git commit -m "docs: verify direct Core IoT charging flow"
~~~
