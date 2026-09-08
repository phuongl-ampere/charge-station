import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceEvent } from "@charge-station/contracts";

import { ChargeStationEventClient } from "./charge-station-event.client";

const event: DeviceEvent = {
  eventId: "event-1",
  commandId: "command-1",
  sessionId: "session-1",
  deviceId: "dev-ST01",
  connectorCode: "ST01-C01",
  type: "RUNNING",
  occurredAt: "2026-09-08T00:00:00.000Z",
  payload: { relayState: "ON" },
};

describe("ChargeStationEventClient", () => {
  const originalApiUrl = process.env.CHARGE_STATION_API_URL;
  const originalServiceToken = process.env.SERVICE_TOKEN;
  const originalRequestTimeout = process.env.IOT_EVENT_REQUEST_TIMEOUT_MS;
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: ChargeStationEventClient;

  beforeEach(() => {
    process.env.SERVICE_TOKEN = "test-service-token";
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal("fetch", fetchMock);
    client = new ChargeStationEventClient();
  });

  afterEach(() => {
    if (originalApiUrl === undefined) {
      delete process.env.CHARGE_STATION_API_URL;
    } else {
      process.env.CHARGE_STATION_API_URL = originalApiUrl;
    }
    if (originalServiceToken === undefined) {
      delete process.env.SERVICE_TOKEN;
    } else {
      process.env.SERVICE_TOKEN = originalServiceToken;
    }
    if (originalRequestTimeout === undefined) {
      delete process.env.IOT_EVENT_REQUEST_TIMEOUT_MS;
    } else {
      process.env.IOT_EVENT_REQUEST_TIMEOUT_MS = originalRequestTimeout;
    }
    vi.unstubAllGlobals();
  });

  it.each([
    "http://localhost:4000",
    "http://127.0.0.1:4000",
    "http://[::1]:4000",
    "http://charge-station-api:4000",
  ])("allows the local callback destination %s", async (apiUrl) => {
    process.env.CHARGE_STATION_API_URL = apiUrl;

    await expect(client.post(event)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      `${apiUrl}/internal/device-events`,
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({
          "x-service-token": "test-service-token",
        }),
      }),
    );
  });

  it("rejects a non-local callback destination before making a request", async () => {
    process.env.CHARGE_STATION_API_URL = "https://example.com";

    await expect(client.post(event)).rejects.toThrow(
      "must use a local callback destination",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when SERVICE_TOKEN is missing", async () => {
    delete process.env.SERVICE_TOKEN;

    await expect(client.post(event)).rejects.toThrow(
      "SERVICE_TOKEN must be configured",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("supplies a bounded abort signal for callback delivery", async () => {
    process.env.CHARGE_STATION_API_URL = "http://localhost:4000";
    process.env.IOT_EVENT_REQUEST_TIMEOUT_MS = "25";
    client = new ChargeStationEventClient();

    await expect(client.post(event)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/internal/device-events",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
