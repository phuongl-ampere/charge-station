import { readFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import {
  ensureDevice,
  isolatedChargeStationRuntime,
  isolatedCoreUrls,
  PublicCoreClient,
  run,
  waitForChargingTelemetry,
  waitForStoppedTelemetry,
  writeDeviceTokenEnvironment,
} from "./core-iot-local-e2e.js";

afterEach(() => {
  delete process.env.IOT_CORE_DEVICE_ID;
  delete process.env.IOT_CORE_DEVICE_TOKEN;
  delete process.env.IOT_CORE_ACCESS_TOKEN;
  delete process.env.CORE_TENANT_PASSWORD;
  delete process.env.CORE_USER_PASSWORD;
  delete process.env.CORE_IOT_PUBLIC_URL;
  delete process.env.CORE_IOT_MANAGEMENT_URL;
  delete process.env.CHARGE_STATION_API_URL;
  delete process.env.CHARGE_STATION_API_HOST_PORT;
  delete process.env.CHARGE_STATION_WEB_HOST_PORT;
  delete process.env.CHARGE_STATION_POSTGRES_HOST_PORT;
  delete process.env.CHARGE_STATION_WEB_ORIGIN;
  delete process.env.CHARGE_STATION_COMPOSE_PROJECT_NAME;
  spawnMock.mockReset();
  vi.unstubAllGlobals();
});

describe("Core IoT local runtime", () => {
  it("runs no iot-service mock and passes Core configuration to API", async () => {
    const compose = await readFile("docker-compose.yml", "utf8");

    expect(compose).not.toContain("iot-service:");
    expect(compose).not.toContain("MOCK_IOT_");
    expect(compose).toContain("IOT_CORE_PUBLIC_URL");
    expect(compose).toContain("core-iot-device-simulator:");
    expect(compose).toContain("CHARGE_STATION_API_HOST_PORT:-4000");
    expect(compose).toContain("CHARGE_STATION_WEB_HOST_PORT:-3100");
    expect(compose).toContain("CHARGE_STATION_POSTGRES_HOST_PORT:-5432");
    expect(compose).toContain(
      "CHARGE_STATION_API_ORIGIN:-http://127.0.0.1:4000",
    );
    expect(compose).toContain(
      "CHARGE_STATION_WEB_ORIGIN:-http://127.0.0.1:3100",
    );
  });

  it("uses separate default ports and Compose project for the local Core harness", () => {
    const runtime = isolatedChargeStationRuntime({});

    expect(runtime.apiUrl.href).toBe("http://127.0.0.1:4100/");
    expect(runtime.webUrl.href).toBe("http://127.0.0.1:3110/");
    expect(runtime.postgresHostPort).toBe(5433);
    expect(runtime.composeProjectName).toBe("charge-station-core-iot-e2e");
  });

  it("honors explicit local harness port and project overrides", () => {
    const runtime = isolatedChargeStationRuntime({
      CHARGE_STATION_API_HOST_PORT: "4200",
      CHARGE_STATION_WEB_HOST_PORT: "3200",
      CHARGE_STATION_POSTGRES_HOST_PORT: "5544",
      CHARGE_STATION_COMPOSE_PROJECT_NAME: "charge-station-review-e2e",
    });

    expect(runtime.apiUrl.href).toBe("http://127.0.0.1:4200/");
    expect(runtime.webUrl.href).toBe("http://127.0.0.1:3200/");
    expect(runtime.postgresHostPort).toBe(5544);
    expect(runtime.composeProjectName).toBe("charge-station-review-e2e");
  });

  it("rejects provisioning endpoints other than the isolated local Core", () => {
    expect(() =>
      isolatedCoreUrls({ CORE_IOT_PUBLIC_URL: "http://localhost:18090" }),
    ).toThrow("CORE_IOT_PUBLIC_URL must be the isolated local Core endpoint");
    expect(() =>
      isolatedCoreUrls({ CORE_IOT_MANAGEMENT_URL: "http://127.0.0.1:18092" }),
    ).toThrow(
      "CORE_IOT_MANAGEMENT_URL must be the isolated local Core endpoint",
    );
  });

  it("keeps a provisioned device token in a private temporary directory", async () => {
    const runtimeSecret = await writeDeviceTokenEnvironment(
      "created-device-id",
      "test-device-token",
    );
    try {
      expect((await stat(runtimeSecret.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(runtimeSecret.envFile)).mode & 0o777).toBe(0o600);
      expect(await readFile(runtimeSecret.envFile, "utf8")).toBe(
        "IOT_CORE_DEVICE_ID=created-device-id\nIOT_CORE_DEVICE_TOKEN=test-device-token\n",
      );
    } finally {
      await runtimeSecret.dispose();
    }
  });

  it("provisions and assigns a device when no configured Core device exists", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/api/management/devices") {
        return jsonResponse(200, []);
      }
      if (path === "/api/management/devices") {
        return jsonResponse(201, { device_id: "created-device-id" });
      }
      if (path === "/api/management/devices/created-device-id/owner") {
        return new Response(null, { status: 204 });
      }
      if (path === "/api/management/devices/created-device-id/token") {
        return jsonResponse(200, { token: "created-device-token" });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    fetchMock.mockImplementationOnce(async () => jsonResponse(200, []));
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse(201, { device_id: "created-device-id" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      ensureDevice(
        { slug: "tenant1", session: { cookie: "iot_nano_session=test" } },
        { id: "user-id", username: "user-a" },
        { name: "Charge Station Simulator" },
      ),
    ).resolves.toEqual({
      id: "created-device-id",
      token: "created-device-token",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        pathname: "/api/management/devices",
      }),
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        pathname: "/api/management/devices/created-device-id/owner",
      }),
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("rejects redirects from Core management requests", async () => {
    process.env.IOT_CORE_DEVICE_ID = "existing-device-id";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, [{ device_id: "existing-device-id" }]),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        jsonResponse(200, { token: "existing-device-token" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await ensureDevice(
      { slug: "tenant1", session: { cookie: "iot_nano_session=test" } },
      { id: "user-id", username: "user-a" },
      { name: "Charge Station Simulator" },
    );

    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({ redirect: "error" });
    }
  });

  it("reads Core telemetry fields and rejects public API redirects", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        items: [
          {
            event_at: "2026-09-26T01:00:02.000Z",
            measurements: {
              relay_state: true,
              session_id: "session-1",
              current_a: 10.2,
              power_w: 2350,
              energy_kwh: 0.0174,
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new PublicCoreClient(
        new URL("http://127.0.0.1:18090"),
        "delegated-token",
      ).latestTelemetry("core-device"),
    ).resolves.toEqual({
      eventAt: "2026-09-26T01:00:02.000Z",
      relayState: true,
      sessionId: "session-1",
      currentA: 10.2,
      powerW: 2350,
      energyKwh: 0.0174,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "/api/v1/telemetry/core-device",
      }),
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("waits past wrong-session and stale telemetry before confirming charging", async () => {
    const fresh = new Date().toISOString();
    const matching = {
      eventAt: fresh,
      relayState: true,
      sessionId: "expected-session",
      currentA: 10.2,
      powerW: 2350,
      energyKwh: 0.0174,
    };
    const core = {
      latestTelemetry: vi
        .fn()
        .mockResolvedValueOnce({ ...matching, sessionId: "old-session" })
        .mockResolvedValueOnce({
          ...matching,
          eventAt: new Date(Date.now() - 16_000).toISOString(),
        })
        .mockResolvedValueOnce({ ...matching, currentA: 0, powerW: 0 })
        .mockResolvedValueOnce(matching),
    };

    await expect(
      waitForChargingTelemetry(core, "created-device-id", "expected-session"),
    ).resolves.toEqual(matching);
    expect(core.latestTelemetry).toHaveBeenCalledTimes(4);
  });

  it("waits until Core reports a cleared session with the relay off", async () => {
    const stopped = {
      eventAt: new Date().toISOString(),
      relayState: false,
      sessionId: null,
      currentA: 0,
      powerW: 0,
      energyKwh: 0.0174,
    };
    const core = {
      latestTelemetry: vi
        .fn()
        .mockResolvedValueOnce({ ...stopped, relayState: true })
        .mockResolvedValueOnce({ ...stopped, sessionId: "expected-session" })
        .mockResolvedValueOnce(stopped),
    };

    await expect(
      waitForStoppedTelemetry(core, "created-device-id"),
    ).resolves.toEqual(stopped);
    expect(core.latestTelemetry).toHaveBeenCalledTimes(3);
  });

  it("polls through stale relay state while running a freshly provisioned device", async () => {
    process.env.CORE_TENANT_PASSWORD = "tenant-password";
    process.env.CORE_USER_PASSWORD = "user-password";
    process.env.IOT_CORE_ACCESS_TOKEN = "delegated-token";
    process.env.IOT_CORE_DEVICE_ID = "stale-device-id";
    process.env.IOT_CORE_DEVICE_TOKEN = "stale-device-token";
    const child = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    });
    const telemetry = [
      telemetryResponse(false, null, 0, 0),
      telemetryResponse(true, "previous-session", 10.2, 2350),
      telemetryResponse(true, "session-1", 10.2, 2350),
      telemetryResponse(true, "session-1", 10.2, 2350),
      telemetryResponse(false, null, 0, 0),
    ];
    let sessionStatusCalls = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input.toString());
        if (url.origin === "http://127.0.0.1:18091") {
          if (url.pathname === "/api/tenant/auth/login") {
            return jsonResponse(
              200,
              {},
              {
                "set-cookie": "iot_nano_session=test; Path=/; HttpOnly",
              },
            );
          }
          if (url.pathname === "/api/management/users") {
            return jsonResponse(200, [
              { id: "user-id", username: "user-a", account_class: "user" },
            ]);
          }
          if (
            url.pathname === "/api/management/devices" &&
            init?.method !== "POST"
          ) {
            return jsonResponse(200, []);
          }
          if (url.pathname === "/api/management/devices") {
            return jsonResponse(201, { device_id: "created-device-id" });
          }
          if (
            url.pathname === "/api/management/devices/created-device-id/owner"
          ) {
            return new Response(null, { status: 204 });
          }
          if (
            url.pathname === "/api/management/devices/created-device-id/token"
          ) {
            return jsonResponse(200, { token: "created-device-token" });
          }
        }
        if (url.origin === "http://127.0.0.1:18090") {
          const next = telemetry.shift();
          if (!next) throw new Error("Unexpected Core telemetry request");
          return jsonResponse(200, { items: [next] });
        }
        if (url.origin === "http://127.0.0.1:4100") {
          if (url.pathname === "/auth/login") {
            return jsonResponse(201, { accessToken: "admin-access-token" });
          }
          if (url.pathname === "/admin/stations") {
            return jsonResponse(200, [
              {
                deviceId: "created-device-id",
                telemetry: {
                  status: "AVAILABLE",
                  eventAt: new Date().toISOString(),
                  relayState: true,
                  sessionId: "session-1",
                  currentA: 10.2,
                  powerW: 2350,
                  energyKwh: 0.0174,
                },
              },
            ]);
          }
          if (url.pathname === "/orders") {
            return jsonResponse(201, {
              orderId: "order-1",
              realtimeAccessToken: "order-capability",
              payment: {
                checkoutUrl:
                  "http://127.0.0.1:4100/payments/payos/mock/order-1",
              },
            });
          }
          if (url.pathname === "/payments/payos/mock/order-1/complete") {
            return jsonResponse(201, {});
          }
          if (url.pathname === "/orders/order-1") {
            return jsonResponse(200, { sessionId: "session-1" });
          }
          if (url.pathname === "/sessions/session-1") {
            sessionStatusCalls += 1;
            return jsonResponse(200, {
              status: sessionStatusCalls === 1 ? "CHARGING" : "CANCELLED",
            });
          }
          if (url.pathname === "/sessions/session-1/stop") {
            return jsonResponse(202, {});
          }
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(run()).resolves.toBeUndefined();
    expect(spawnMock).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["compose", "--env-file"]),
      expect.objectContaining({ env: expect.any(Object) }),
    );
    const spawnOptions = spawnMock.mock.calls[0]?.[2];
    expect(spawnOptions?.env).not.toHaveProperty("IOT_CORE_DEVICE_ID");
    expect(spawnOptions?.env).not.toHaveProperty("IOT_CORE_DEVICE_TOKEN");
    expect(spawnOptions?.env).toMatchObject({
      COMPOSE_PROJECT_NAME: "charge-station-core-iot-e2e",
      CHARGE_STATION_API_HOST_PORT: "4100",
      CHARGE_STATION_API_ORIGIN: "http://127.0.0.1:4100",
      CHARGE_STATION_WEB_HOST_PORT: "3110",
      CHARGE_STATION_WEB_ORIGIN: "http://127.0.0.1:3110",
      CHARGE_STATION_POSTGRES_HOST_PORT: "5433",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: "/admin/stations" }),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer admin-access-token",
        }),
      }),
    );
  });
});

function telemetryResponse(
  relayState: boolean,
  sessionId: string | null,
  currentA: number,
  powerW: number,
) {
  return {
    event_at: new Date().toISOString(),
    measurements: {
      relay_state: relayState,
      session_id: sessionId,
      current_a: currentA,
      power_w: powerW,
      energy_kwh: 0.0174,
    },
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
