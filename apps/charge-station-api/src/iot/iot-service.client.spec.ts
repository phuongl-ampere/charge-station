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
      }),
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
