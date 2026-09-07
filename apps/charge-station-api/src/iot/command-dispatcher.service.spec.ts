import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import type { DataSource } from "typeorm";

import {
  ChargingSession,
  ChargingSessionStatus,
  Connector,
  DeviceCommand,
  DeviceCommandStatus,
} from "../database/data-source.js";
import { CommandDispatcherService } from "./command-dispatcher.service.js";
import { IotServiceClient } from "./iot-service.client.js";

describe("CommandDispatcherService", () => {
  it("sends the immutable command values and marks the persisted command SENT", async () => {
    const command = createCommand();
    const commandRepository = {
      findOne: vi.fn().mockResolvedValue(command),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const dataSource = {
      getRepository: vi.fn().mockReturnValue(commandRepository),
    };
    const iotClient = {
      start: vi.fn().mockResolvedValue(undefined),
    };
    const service = new CommandDispatcherService(
      dataSource as unknown as DataSource,
      iotClient as unknown as IotServiceClient,
    );

    await service.dispatch(command.commandId);

    expect(iotClient.start).toHaveBeenCalledWith({
      commandId: command.commandId,
      sessionId: command.session.id,
      stationCode: "ST01",
      connectorCode: "ST01-C01",
      durationSeconds: 7200,
      expiresAt: "2026-09-08T12:00:00.000Z",
      configVersion: 1,
    });
    expect(command.status).toBe(DeviceCommandStatus.SENT);
    expect(commandRepository.save).toHaveBeenCalledWith(command);
  });

  it("retries transport failures at 1, 5, and 20 seconds without changing command values", async () => {
    const command = createCommand();
    const commandRepository = {
      findOne: vi.fn().mockResolvedValue(command),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const dataSource = {
      getRepository: vi.fn().mockReturnValue(commandRepository),
    };
    const iotClient = {
      start: vi
        .fn()
        .mockRejectedValueOnce(new Error("connection refused"))
        .mockRejectedValueOnce(new Error("connection refused"))
        .mockRejectedValueOnce(new Error("connection refused"))
        .mockResolvedValue(undefined),
    };
    const service = new CommandDispatcherService(
      dataSource as unknown as DataSource,
      iotClient as unknown as IotServiceClient,
    );
    const wait = vi
      .spyOn(service as never, "wait" as never)
      .mockResolvedValue(undefined);

    await service.dispatch(command.commandId);

    expect(iotClient.start).toHaveBeenCalledTimes(4);
    expect(wait).toHaveBeenNthCalledWith(1, 1_000);
    expect(wait).toHaveBeenNthCalledWith(2, 5_000);
    expect(wait).toHaveBeenNthCalledWith(3, 20_000);
    expect(command.retryCount).toBe(3);
    expect(command.status).toBe(DeviceCommandStatus.SENT);
    expect(iotClient.start.mock.calls).toEqual([
      [
        expect.objectContaining({
          commandId: command.commandId,
          durationSeconds: 7200,
        }),
      ],
      [
        expect.objectContaining({
          commandId: command.commandId,
          durationSeconds: 7200,
        }),
      ],
      [
        expect.objectContaining({
          commandId: command.commandId,
          durationSeconds: 7200,
        }),
      ],
      [
        expect.objectContaining({
          commandId: command.commandId,
          durationSeconds: 7200,
        }),
      ],
    ]);
  });
});

function createCommand(): DeviceCommand {
  const connector = {
    id: randomUUID(),
    code: "ST01-C01",
    station: { code: "ST01" },
  } as Connector;
  const session = {
    id: randomUUID(),
    connector,
    status: ChargingSessionStatus.PENDING,
    expectedEndAt: new Date("2026-09-08T12:00:00.000Z"),
  } as ChargingSession;

  return {
    id: randomUUID(),
    commandId: randomUUID(),
    commandType: "START_CHARGING",
    payload: {
      stationCode: "ST01",
      connectorCode: "ST01-C01",
      sessionId: session.id,
      durationSeconds: 7200,
      expiresAt: "2026-09-08T12:00:00.000Z",
      configVersion: 1,
    },
    retryCount: 0,
    status: DeviceCommandStatus.PENDING,
    session,
  } as unknown as DeviceCommand;
}
