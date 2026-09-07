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

  it("safely handles a local callback redirect rejection", async () => {
    process.env.SERVICE_TOKEN = "test-service-token";
    process.env.CHARGE_STATION_API_URL = "http://localhost:4000";
    const fetchMock = vi.fn().mockRejectedValue(
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
    expect(postedTypes).toEqual([
      "COMMAND_ACCEPTED",
      "RUNNING",
      "HEARTBEAT",
    ]);

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
});
