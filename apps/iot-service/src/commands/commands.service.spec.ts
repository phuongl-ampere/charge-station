import { Logger } from "@nestjs/common";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  StartChargingCommand,
  StopChargingCommand,
} from "@charge-station/contracts";

import { CommandsService } from "./commands.service";
import { ChargeStationEventClient } from "../events/charge-station-event.client";
import { EventJournalService } from "../events/event-journal.service";
import { DeviceStateService } from "../devices/device-state.service";

const journalDirectories: string[] = [];

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

  afterEach(async () => {
    await service.onModuleDestroy();
    deviceState.onModuleDestroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
    await Promise.all(
      journalDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
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
    expect(eventClient.post.mock.calls.length).toBeGreaterThanOrEqual(4);
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

  it("retries lost initial ACK and RUNNING callbacks in session order", async () => {
    const attemptsByType = new Map<string, number>();
    const deliveredEvents: Array<Record<string, unknown>> = [];
    eventClient.post.mockImplementation(async (event) => {
      deliveredEvents.push(event as Record<string, unknown>);
      const attempts = (attemptsByType.get(event.type) ?? 0) + 1;
      attemptsByType.set(event.type, attempts);
      if (
        (event.type === "COMMAND_ACCEPTED" || event.type === "RUNNING") &&
        attempts === 1
      ) {
        throw new Error(`lost ${event.type} callback`);
      }
    });

    await service.start(commandWithDuration(5));
    await vi.advanceTimersByTimeAsync(300);

    const initialEvents = deliveredEvents.filter(
      (event) =>
        event.type === "COMMAND_ACCEPTED" || event.type === "RUNNING",
    );
    expect(initialEvents).toHaveLength(4);
    expect(initialEvents[0]?.type).toBe("COMMAND_ACCEPTED");
    expect(initialEvents[1]?.type).toBe("RUNNING");
    expect(
      initialEvents.filter((event) => event.type === "COMMAND_ACCEPTED"),
    ).toEqual([initialEvents[0], initialEvents[2]]);
    expect(
      initialEvents.filter((event) => event.type === "RUNNING"),
    ).toEqual([initialEvents[1], initialEvents[3]]);
    expect(initialEvents[2]).toEqual(initialEvents[0]);
    expect(initialEvents[3]).toEqual(initialEvents[1]);

    await expect(service.stop(stopCommand())).resolves.toMatchObject({
      accepted: true,
      status: "STOPPED",
    });
  });

  it("does not block STOPPED behind a timed-out nonterminal delivery", async () => {
    eventClient.post.mockImplementation((event) => {
      if (event.type === "COMMAND_ACCEPTED") {
        return new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error("callback timed out")), 25);
        });
      }
      return Promise.resolve();
    });

    await service.start(commandWithDuration(1));
    await vi.advanceTimersByTimeAsync(1_100);

    expect(
      eventClient.post.mock.calls
        .map(([event]) => event)
        .filter((event) => event.type === "STOPPED"),
    ).toHaveLength(1);
  });

  it("persists failed critical deliveries with stable event IDs until retries succeed", async () => {
    const path = await journalPath();
    const journal = new EventJournalService(path);
    const attempts = new Map<string, number>();
    eventClient.post.mockImplementation(async (event) => {
      const attemptsForEvent = (attempts.get(event.eventId) ?? 0) + 1;
      attempts.set(event.eventId, attemptsForEvent);
      if (
        (event.type === "COMMAND_ACCEPTED" || event.type === "RUNNING") &&
        attemptsForEvent === 1
      ) {
        throw new Error("simulated lost callback");
      }
    });
    service = new CommandsService(
      eventClient as unknown as ChargeStationEventClient,
      deviceState,
      journal,
    );

    await service.start(commandWithDuration(5));
    await vi.advanceTimersByTimeAsync(300);

    const delivered = eventClient.post.mock.calls
      .map(([event]) => event)
      .filter(
        (event) =>
          event.type === "COMMAND_ACCEPTED" || event.type === "RUNNING",
      );
    expect(delivered).toHaveLength(4);
    expect(delivered[0]?.type).toBe("COMMAND_ACCEPTED");
    expect(delivered[1]?.type).toBe("RUNNING");
    expect(delivered[2]).toEqual(delivered[0]);
    expect(delivered[3]).toEqual(delivered[1]);
    expect(existsSync(path)).toBe(true);
    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      records: Array<Record<string, unknown>>;
    };
    expect(persisted.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({ type: "COMMAND_ACCEPTED" }),
          retryCount: 1,
          delivered: true,
        }),
        expect.objectContaining({
          event: expect.objectContaining({ type: "RUNNING" }),
          retryCount: 1,
          delivered: true,
        }),
      ]),
    );
    expect(await journal.getUndelivered()).toEqual([]);
  });

  it("replays an undelivered STOPPED record after a journal restart", async () => {
    const path = await journalPath();
    const journal = new EventJournalService(path);
    const event = {
      eventId: "event-stopped",
      commandId: "command-1",
      sessionId: "session-1",
      deviceId: "dev_ST01",
      connectorCode: "ST01-C01",
      type: "STOPPED" as const,
      occurredAt: "2026-09-08T12:00:00.000Z",
      payload: { reason: "USER_REQUESTED", relayState: "OFF" },
    };
    await journal.initialize();
    await journal.append(event);
    const restartedJournal = new EventJournalService(path);
    service = new CommandsService(
      eventClient as unknown as ChargeStationEventClient,
      deviceState,
      restartedJournal,
    );
    const replayable = service as unknown as {
      onModuleInit?: () => Promise<void>;
    };

    expect(replayable.onModuleInit).toBeTypeOf("function");
    await replayable.onModuleInit?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(eventClient.post).toHaveBeenCalledWith(event);
    expect(await restartedJournal.getUndelivered()).toEqual([]);
  });

  it("reconciles an interrupted mock runtime with a durable terminal STOPPED event", async () => {
    const path = await journalPath();
    const journal = new EventJournalService(path);
    const running = {
      eventId: "event-running-after-restart",
      commandId: "command-running-after-restart",
      sessionId: "session-running-after-restart",
      deviceId: "dev_ST01",
      connectorCode: "ST01-C01",
      type: "RUNNING" as const,
      occurredAt: new Date().toISOString(),
      payload: { relayState: "ON", remainingSeconds: 300 },
    };
    await journal.initialize();
    await journal.append(running);
    await journal.markDelivered(running.eventId);

    const restarted = new CommandsService(
      eventClient as unknown as ChargeStationEventClient,
      new DeviceStateService(),
      new EventJournalService(path),
    );
    await restarted.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);

    expect(eventClient.post).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: running.commandId,
        sessionId: running.sessionId,
        type: "STOPPED",
        payload: {
          reason: "SYSTEM_REQUESTED",
          relayState: "OFF",
        },
      }),
    );
    await restarted.onModuleDestroy();
  });

  it.each([
    ["command_failed", "COMMAND_FAILED"],
    ["offline", "DEVICE_OFFLINE"],
  ])(
    "retries the $expectedType event without blocking STOPPED delivery",
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
        ).toHaveLength(1);

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
    await service.onModuleDestroy();
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

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4);
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
    await vi.advanceTimersByTimeAsync(0);
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

async function journalPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "charge-station-iot-command-"));
  journalDirectories.push(directory);
  return join(directory, "events.json");
}
