import { afterEach, describe, expect, it, vi } from "vitest";

import { CoreIotClient } from "./core-iot.client.js";

describe("CoreIotClient", () => {
  afterEach(() => {
    delete process.env.IOT_CORE_PUBLIC_URL;
    delete process.env.IOT_CORE_ACCESS_TOKEN;
    delete process.env.IOT_CORE_COMMAND_TIMEOUT_MS;
    delete process.env.IOT_CORE_COMMAND_POLL_MS;
    vi.unstubAllGlobals();
  });

  it("submits a two-way setRelay command and waits for the device response", async () => {
    process.env.IOT_CORE_PUBLIC_URL = "http://core.test:18090";
    process.env.IOT_CORE_ACCESS_TOKEN = "delegated-token";
    process.env.IOT_CORE_COMMAND_POLL_MS = "1";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(202, { id: "core-command", state: "queued" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "core-command",
          state: "responded",
          response: {
            ok: true,
            result: {
              relayId: "relay-1",
              enabled: true,
              remainingSeconds: 3600,
            },
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new CoreIotClient().setRelay({
        commandId: "charge-command",
        deviceId: "core-device",
        relayId: "relay-1",
        enabled: true,
        durationSeconds: 3600,
        sessionId: "session-1",
      }),
    ).resolves.toEqual({
      commandId: "core-command",
      relayId: "relay-1",
      enabled: true,
      remainingSeconds: 3600,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://core.test:18090/api/v1/devices/core-device/commands",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer delegated-token",
          "idempotency-key": "charge-command",
        }),
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual({
      method: "setRelay",
      mode: "two_way",
      params: {
        relayId: "relay-1",
        enabled: true,
        durationSeconds: 3600,
        sessionId: "session-1",
      },
    });
  });

  it("returns the latest Core telemetry item without inventing missing values", async () => {
    process.env.IOT_CORE_PUBLIC_URL = "http://core.test:18090";
    process.env.IOT_CORE_ACCESS_TOKEN = "delegated-token";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          items: [
            {
              event_at: "2026-09-25T01:00:01.000Z",
              measurements: { voltage_v: 220, power_w: 2200 },
            },
            {
              event_at: "2026-09-25T01:00:02.000Z",
              measurements: {
                relay_state: true,
                session_id: "session-1",
                remaining_seconds: 3599,
                voltage_v: 230.4,
                current_a: 10.2,
                power_w: 2350,
                energy_kwh: 0.0174,
              },
            },
          ],
        }),
      ),
    );

    await expect(new CoreIotClient().latestTelemetry("core-device")).resolves.toEqual({
      eventAt: "2026-09-25T01:00:02.000Z",
      relayState: true,
      sessionId: "session-1",
      remainingSeconds: 3599,
      lastStopReason: null,
      voltageV: 230.4,
      currentA: 10.2,
      powerW: 2350,
      energyKwh: 0.0174,
    });
  });
});

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
