import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IotCommandRejectedError,
  IotServiceClient,
  IotTransportError,
} from "./iot-service.client.js";

const command = {
  commandId: "cmd_1",
  sessionId: "session_1",
  stationCode: "ST01",
  connectorCode: "ST01-C01",
  durationSeconds: 3600,
  expiresAt: "2026-09-08T12:00:00.000Z",
  configVersion: 1,
};
const stopCommand = {
  commandId: "cmd_stop_1",
  sessionId: "session_1",
  reason: "USER_REQUESTED" as const,
};

describe("IotServiceClient", () => {
  afterEach(() => {
    delete process.env.IOT_SERVICE_URL;
    delete process.env.SERVICE_TOKEN;
    delete process.env.IOT_COMMAND_REQUEST_TIMEOUT_MS;
    vi.unstubAllGlobals();
  });

  it("posts a start command only to the configured local IoT service", async () => {
    process.env.IOT_SERVICE_URL = "http://127.0.0.1:4100/api";
    process.env.SERVICE_TOKEN = "local-token";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ commandId: command.commandId, accepted: true }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await new IotServiceClient().start(command);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4100/api/internal/commands/start",
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({
          "x-service-token": "local-token",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("uses a bounded command timeout", async () => {
    process.env.IOT_SERVICE_URL = "http://localhost:4100";
    process.env.SERVICE_TOKEN = "local-token";
    process.env.IOT_COMMAND_REQUEST_TIMEOUT_MS = "25";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ commandId: command.commandId, accepted: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await new IotServiceClient().start(command);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4100/internal/commands/start",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("posts a stop command only to the configured local IoT service", async () => {
    process.env.IOT_SERVICE_URL = "http://127.0.0.1:4100/api";
    process.env.SERVICE_TOKEN = "local-token";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ commandId: stopCommand.commandId, accepted: true }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await new IotServiceClient().stop(stopCommand);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4100/api/internal/commands/stop",
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({
          "x-service-token": "local-token",
        }),
      }),
    );
  });

  it("probes the configured local IoT health endpoint", async () => {
    process.env.IOT_SERVICE_URL = "http://iot-service:4001/api";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(new IotServiceClient().isHealthy()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://iot-service:4001/api/health",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
      }),
    );
  });

  it("treats an unavailable local IoT health endpoint as not ready", async () => {
    process.env.IOT_SERVICE_URL = "http://iot-service:4001";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 503,
        }),
      ),
    );

    await expect(new IotServiceClient().isHealthy()).resolves.toBe(false);
  });

  it("rejects a non-local IoT service URL before making a request", async () => {
    process.env.IOT_SERVICE_URL = "https://iot.example.test";
    process.env.SERVICE_TOKEN = "local-token";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new IotServiceClient().start(command)).rejects.toThrow(
      "IOT_SERVICE_URL must use a local service destination",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a service token before making a request", async () => {
    process.env.IOT_SERVICE_URL = "http://localhost:4100";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new IotServiceClient().start(command)).rejects.toThrow(
      "SERVICE_TOKEN must be configured",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies network failures as transport errors", async () => {
    process.env.IOT_SERVICE_URL = "http://localhost:4100";
    process.env.SERVICE_TOKEN = "local-token";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    await expect(new IotServiceClient().start(command)).rejects.toBeInstanceOf(
      IotTransportError,
    );
  });

  it("classifies malformed successful responses as rejected commands", async () => {
    process.env.IOT_SERVICE_URL = "http://localhost:4100";
    process.env.SERVICE_TOKEN = "local-token";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(new IotServiceClient().start(command)).rejects.toBeInstanceOf(
      IotCommandRejectedError,
    );
  });
});
