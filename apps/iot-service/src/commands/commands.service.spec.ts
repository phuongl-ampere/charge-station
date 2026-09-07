import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { StartChargingCommand } from "@charge-station/contracts";

import { CommandsService } from "./commands.service";
import type { ChargeStationEventClient } from "../events/charge-station-event.client";

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
  let service: CommandsService;

  beforeEach(() => {
    vi.useFakeTimers();
    eventClient = {
      post: vi.fn().mockResolvedValue(undefined),
    };
    service = new CommandsService(
      eventClient as unknown as ChargeStationEventClient,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits RUNNING and then STOPPED with TIMER_EXPIRED for an accepted start command", async () => {
    await service.start(commandWithDuration(2));

    await vi.advanceTimersByTimeAsync(100);
    expect(eventClient.post).toHaveBeenCalledWith(
      expect.objectContaining({ type: "RUNNING" }),
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
  });
});
