import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartChargingCommand } from "@charge-station/contracts";

import { CommandsService } from "./commands.service";
import type { ChargeStationEventClient } from "../events/charge-station-event.client";
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
