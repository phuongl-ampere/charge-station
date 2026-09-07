import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  StartChargingCommand,
  StopChargingCommand,
} from "@charge-station/contracts";

import { CommandsService } from "./commands.service";
import { ChargeStationEventClient } from "../events/charge-station-event.client";
import { DeviceStateService } from "../devices/device-state.service";

function commandWithDuration(durationSeconds: number): StartChargingCommand {
  return {
    commandId: "command-1",
    sessionId: "session-1",
    stationCode: "ST01",
    connectorCode: "ST01-C01",
    durationSeconds,
    expiresAt: new Date(Date.now() + durationSeconds * 1000).toISOString(),
    configVersion: 1,
  };
}

function stopCommand(): StopChargingCommand {
  return {
    commandId: "stop-command-1",
    sessionId: "session-1",
    reason: "USER_REQUESTED",
  };
}

describe("CommandsService", () => {
  let eventClient: { post: ReturnType<typeof vi.fn> };
  let deviceState: DeviceStateService;
  let service: CommandsService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    eventClient = {
      post: vi.fn().mockResolvedValue(undefined),
    };
    deviceState = new DeviceStateService();
    service = new CommandsService(
      eventClient as unknown as ChargeStationEventClient,
      deviceState,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("emits the accepted, running, heartbeat, and expiry event sequence", async () => {
    await service.start(commandWithDuration(3));

    await vi.advanceTimersByTimeAsync(100);
    expect(eventClient.post).toHaveBeenCalledWith(
      expect.objectContaining({ type: "RUNNING" }),
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(eventClient.post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "HEARTBEAT",
        payload: expect.objectContaining({
          remainingSeconds: 2,
          relayState: "ON",
        }),
      }),
    );

    await vi.advanceTimersByTimeAsync(2000);
    expect(eventClient.post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "STOPPED",
        payload: expect.objectContaining({
          reason: "TIMER_EXPIRED",
          relayState: "OFF",
        }),
      }),
    );

    expect(eventClient.post.mock.calls.map(([event]) => event.type)).toEqual([
      "COMMAND_ACCEPTED",
      "RUNNING",
      "HEARTBEAT",
      "HEARTBEAT",
      "STOPPED",
    ]);
  });

  it.each([
    ["an expired timestamp", "2026-09-08T10:00:00.000Z"],
    ["a noncanonical ISO timestamp", "2026-09-08T12:00:00+00:00"],
  ])(
    "rejects a START command with %s before creating device state",
    async (_name, expiresAt) => {
      vi.setSystemTime(new Date("2026-09-08T11:00:00.000Z"));
      const command = {
        ...commandWithDuration(60),
        expiresAt,
      };

      await expect(service.start(command)).resolves.toMatchObject({
        commandId: command.commandId,
        accepted: false,
        status: "REJECTED",
      });

      expect(deviceState.getCommand(command.commandId)).toBeUndefined();
      expect(deviceState.getConnector(command.connectorCode)).toBeUndefined();
      expect(eventClient.post).not.toHaveBeenCalled();
    },
  );

  it("keeps the command accepted and turns the relay off when event delivery fails", async () => {
    eventClient.post.mockRejectedValue(new Error("Charge Station unavailable"));

    await expect(service.start(commandWithDuration(2))).resolves.toMatchObject({
      accepted: true,
      status: "ACCEPTED",
    });

    await vi.advanceTimersByTimeAsync(2100);

    expect(deviceState.getConnector("ST01-C01")).toBeUndefined();
    expect(eventClient.post).toHaveBeenCalledTimes(4);
  });

  it("retries a lost STOPPED delivery with its original event ID", async () => {
    let stoppedAttempts = 0;
    eventClient.post.mockImplementation(async (event) => {
      if (event.type === "STOPPED" && stoppedAttempts++ === 0) {
        throw new Error("lost STOPPED callback");
      }
    });

    await service.start(commandWithDuration(1));
    await vi.advanceTimersByTimeAsync(1100);
    const firstStopped = eventClient.post.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === "STOPPED");

    expect(firstStopped).toBeDefined();
    await vi.advanceTimersByTimeAsync(100);
    const stoppedEvents = eventClient.post.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "STOPPED");

    expect(stoppedEvents).toHaveLength(2);
    expect(stoppedEvents[1].eventId).toBe(firstStopped?.eventId);
  });

  it.each([
    ["command_failed", "COMMAND_FAILED"],
    ["offline", "DEVICE_OFFLINE"],
  ])(
    "retries the $expectedType terminal failure event before STOPPED",
    async (mode, expectedType) => {
      const previousMode = process.env.MOCK_IOT_FAILURE_MODE;
      process.env.MOCK_IOT_FAILURE_MODE = mode;
      let terminalAttempts = 0;
      eventClient.post.mockImplementation(async (event) => {
        if (event.type === expectedType && terminalAttempts++ === 0) {
          throw new Error("lost terminal callback");
        }
      });

      try {
        await service.start(commandWithDuration(3));
        await vi.advanceTimersByTimeAsync(100);
        const firstFailure = eventClient.post.mock.calls
          .map(([event]) => event)
          .find((event) => event.type === expectedType);

        expect(firstFailure).toBeDefined();
        expect(
          eventClient.post.mock.calls
            .map(([event]) => event)
            .filter((event) => event.type === "STOPPED"),
        ).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(100);
        const failures = eventClient.post.mock.calls
          .map(([event]) => event)
          .filter((event) => event.type === expectedType);

        expect(failures).toHaveLength(2);
        expect(failures[1].eventId).toBe(firstFailure?.eventId);
        expect(
          eventClient.post.mock.calls
            .map(([event]) => event)
            .filter((event) => event.type === "STOPPED"),
        ).toHaveLength(1);
      } finally {
        if (previousMode === undefined) {
          delete process.env.MOCK_IOT_FAILURE_MODE;
        } else {
          process.env.MOCK_IOT_FAILURE_MODE = previousMode;
        }
      }
    },
  );

  it("clears pending terminal retry timers when device state is destroyed", async () => {
    eventClient.post.mockImplementation(async (event) => {
      if (event.type === "STOPPED") {
        throw new Error("Charge Station unavailable");
      }
    });

    await service.start(commandWithDuration(1));
    await vi.advanceTimersByTimeAsync(1100);

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const lifecycleState = deviceState as unknown as {
      onModuleDestroy(): void;
    };
    lifecycleState.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("safely handles a local callback redirect rejection", async () => {
    process.env.SERVICE_TOKEN = "test-service-token";
    process.env.CHARGE_STATION_API_URL = "http://localhost:4000";
    const fetchMock = vi
      .fn()
      .mockRejectedValue(
        new TypeError("fetch failed because redirect mode is error"),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ChargeStationEventClient();
    service = new CommandsService(client, deviceState);

    await expect(service.start(commandWithDuration(2))).resolves.toMatchObject({
      accepted: true,
      status: "ACCEPTED",
    });

    await vi.advanceTimersByTimeAsync(2100);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(deviceState.getConnector("ST01-C01")).toBeUndefined();
  });

  it("serializes event delivery within a session when callbacks resolve at different times", async () => {
    const postedTypes: string[] = [];
    const resolvers = new Map<string, Array<() => void>>();
    eventClient.post.mockImplementation((event) => {
      postedTypes.push(event.type);
      return new Promise<void>((resolve) => {
        const typeResolvers = resolvers.get(event.type) ?? [];
        typeResolvers.push(resolve);
        resolvers.set(event.type, typeResolvers);
      });
    });

    const release = (type: string, occurrence = 0) => {
      resolvers.get(type)?.[occurrence]?.();
    };

    await service.start(commandWithDuration(3));
    expect(postedTypes).toEqual(["COMMAND_ACCEPTED"]);

    await vi.advanceTimersByTimeAsync(3100);
    expect(postedTypes).toEqual(["COMMAND_ACCEPTED"]);

    release("COMMAND_ACCEPTED");
    await vi.advanceTimersByTimeAsync(0);
    expect(postedTypes).toEqual(["COMMAND_ACCEPTED", "RUNNING"]);

    release("RUNNING");
    await vi.advanceTimersByTimeAsync(0);
    expect(postedTypes).toEqual(["COMMAND_ACCEPTED", "RUNNING", "HEARTBEAT"]);

    release("HEARTBEAT");
    await vi.advanceTimersByTimeAsync(0);
    expect(postedTypes).toEqual([
      "COMMAND_ACCEPTED",
      "RUNNING",
      "HEARTBEAT",
      "HEARTBEAT",
    ]);

    release("HEARTBEAT", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(postedTypes).toEqual([
      "COMMAND_ACCEPTED",
      "RUNNING",
      "HEARTBEAT",
      "HEARTBEAT",
      "STOPPED",
    ]);
  });

  it("clears heartbeat and expiry timers after a manual stop", async () => {
    await service.start(commandWithDuration(3));
    await vi.advanceTimersByTimeAsync(1100);

    await expect(service.stop(stopCommand())).resolves.toMatchObject({
      accepted: true,
      status: "STOPPED",
    });

    const heartbeatCount = eventClient.post.mock.calls.filter(
      ([event]) => event.type === "HEARTBEAT",
    ).length;
    const stoppedCount = eventClient.post.mock.calls.filter(
      ([event]) => event.type === "STOPPED",
    ).length;

    await vi.advanceTimersByTimeAsync(5000);

    expect(
      eventClient.post.mock.calls.filter(
        ([event]) => event.type === "HEARTBEAT",
      ),
    ).toHaveLength(heartbeatCount);
    expect(
      eventClient.post.mock.calls.filter(([event]) => event.type === "STOPPED"),
    ).toHaveLength(stoppedCount);
  });

  it("deduplicates a command without creating a second timer", async () => {
    const command = commandWithDuration(1);

    await service.start(command);
    await service.start(command);
    await vi.advanceTimersByTimeAsync(1100);

    expect(
      eventClient.post.mock.calls.filter(
        ([event]) => event.type === "COMMAND_ACCEPTED",
      ),
    ).toHaveLength(1);
    expect(
      eventClient.post.mock.calls.filter(([event]) => event.type === "RUNNING"),
    ).toHaveLength(1);
    expect(
      eventClient.post.mock.calls.filter(([event]) => event.type === "STOPPED"),
    ).toHaveLength(1);
  });

  it.each([
    {
      mode: "timeout",
      expectedTypes: ["COMMAND_ACCEPTED", "COMMAND_FAILED", "STOPPED"],
    },
    {
      mode: "command_failed",
      expectedTypes: ["COMMAND_ACCEPTED", "COMMAND_FAILED", "STOPPED"],
    },
    {
      mode: "offline",
      expectedTypes: [
        "COMMAND_ACCEPTED",
        "DEVICE_OFFLINE",
        "COMMAND_FAILED",
        "STOPPED",
      ],
    },
  ])(
    "turns the relay off and emits a terminal failure sequence for $mode",
    async ({ mode, expectedTypes }) => {
      const previousMode = process.env.MOCK_IOT_FAILURE_MODE;
      process.env.MOCK_IOT_FAILURE_MODE = mode;

      try {
        await service.start(commandWithDuration(3));
        await vi.advanceTimersByTimeAsync(100);

        expect(deviceState.getConnector("ST01-C01")).toBeUndefined();
        expect(
          eventClient.post.mock.calls.map(([event]) => event.type),
        ).toEqual(expectedTypes);
        expect(eventClient.post).toHaveBeenLastCalledWith(
          expect.objectContaining({
            type: "STOPPED",
            payload: expect.objectContaining({ relayState: "OFF" }),
          }),
        );
      } finally {
        if (previousMode === undefined) {
          delete process.env.MOCK_IOT_FAILURE_MODE;
        } else {
          process.env.MOCK_IOT_FAILURE_MODE = previousMode;
        }
      }
    },
  );
});
