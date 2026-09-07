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
import {
  IotCommandRejectedError,
  IotServiceClient,
  IotTransportError,
} from "./iot-service.client.js";

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

  it("sends a persisted stop command through the same dispatcher", async () => {
    const command = createCommand({
      commandType: "STOP_CHARGING",
      payload: {
        sessionId: "session_1",
        reason: "USER_REQUESTED",
      },
    });
    const commandRepository = {
      findOne: vi.fn().mockResolvedValue(command),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const dataSource = {
      getRepository: vi.fn().mockReturnValue(commandRepository),
    };
    const iotClient = {
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const service = new CommandDispatcherService(
      dataSource as unknown as DataSource,
      iotClient as unknown as IotServiceClient,
    );

    await service.dispatch(command.commandId);

    expect(iotClient.stop).toHaveBeenCalledWith({
      commandId: command.commandId,
      sessionId: "session_1",
      reason: "USER_REQUESTED",
    });
    expect(iotClient.start).not.toHaveBeenCalled();
    expect(command.status).toBe(DeviceCommandStatus.SENT);
  });

  it("persists the 1, 5, and 20 second transport retry schedule without changing command values", async () => {
    const command = createCommand();
    const saves: Array<{
      nextAttemptAt: Date | null | undefined;
      retryCount: number;
      status: DeviceCommandStatus;
    }> = [];
    const commandRepository = {
      findOne: vi.fn().mockResolvedValue(command),
      save: vi.fn().mockImplementation(async (entity: DeviceCommand) => {
        saves.push({
          nextAttemptAt: entity.nextAttemptAt,
          retryCount: entity.retryCount,
          status: entity.status,
        });
        return entity;
      }),
    };
    const dataSource = {
      getRepository: vi.fn().mockReturnValue(commandRepository),
    };
    const iotClient = {
      start: vi
        .fn()
        .mockRejectedValueOnce(new IotTransportError("connection refused"))
        .mockRejectedValueOnce(new IotTransportError("connection refused"))
        .mockRejectedValueOnce(new IotTransportError("connection refused"))
        .mockResolvedValue(undefined),
    };
    const service = new CommandDispatcherService(
      dataSource as unknown as DataSource,
      iotClient as unknown as IotServiceClient,
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T11:00:00.000Z"));
    const wait = vi
      .spyOn(service as never, "wait" as never)
      .mockImplementation(async (...args: unknown[]) => {
        const [delayMs] = args as [number];
        vi.setSystemTime(new Date(Date.now() + delayMs));
      });

    try {
      await service.dispatch(command.commandId);
    } finally {
      vi.useRealTimers();
    }

    expect(iotClient.start).toHaveBeenCalledTimes(4);
    expect(wait).toHaveBeenNthCalledWith(1, 1_000);
    expect(wait).toHaveBeenNthCalledWith(2, 5_000);
    expect(wait).toHaveBeenNthCalledWith(3, 20_000);
    expect(command.retryCount).toBe(3);
    expect(command.status).toBe(DeviceCommandStatus.SENT);
    expect(command.nextAttemptAt).toBeNull();
    expect(saves).toEqual([
      {
        retryCount: 1,
        nextAttemptAt: new Date("2026-09-08T11:00:01.000Z"),
        status: DeviceCommandStatus.PENDING,
      },
      {
        retryCount: 2,
        nextAttemptAt: new Date("2026-09-08T11:00:06.000Z"),
        status: DeviceCommandStatus.PENDING,
      },
      {
        retryCount: 3,
        nextAttemptAt: new Date("2026-09-08T11:00:26.000Z"),
        status: DeviceCommandStatus.PENDING,
      },
      {
        retryCount: 3,
        nextAttemptAt: null,
        status: DeviceCommandStatus.SENT,
      },
    ]);
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

  it("marks an exhausted start retry failed, releases the connector, and publishes the terminal session state", async () => {
    const command = createCommand();
    const commandRepository = {
      findOne: vi.fn().mockResolvedValue(command),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const sessionRepository = {
      findOneBy: vi.fn().mockResolvedValue(command.session),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const connectorRepository = {
      findOne: vi.fn().mockResolvedValue(command.session.connector),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const manager = {
      query: vi.fn().mockImplementation(async (query: string) => {
        if (query.includes("FROM charging_sessions")) {
          return [{ id: command.session.id }];
        }
        if (query.includes("FROM connectors")) {
          return [{ id: command.session.connector.id }];
        }
        throw new Error("Unexpected lock query");
      }),
      getRepository: vi.fn((entity) => {
        if (entity === DeviceCommand) return commandRepository;
        if (entity === ChargingSession) return sessionRepository;
        if (entity === Connector) return connectorRepository;
        throw new Error("Unexpected repository");
      }),
    };
    const dataSource = {
      getRepository: vi.fn().mockReturnValue(commandRepository),
      transaction: vi.fn(async (callback) => callback(manager)),
    };
    const iotClient = {
      start: vi
        .fn()
        .mockRejectedValue(new IotTransportError("connection refused")),
    };
    const gateway = { publishSession: vi.fn() };
    const service = new CommandDispatcherService(
      dataSource as unknown as DataSource,
      iotClient as unknown as IotServiceClient,
      gateway as never,
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T11:00:00.000Z"));
    const wait = vi
      .spyOn(service as never, "wait" as never)
      .mockImplementation(async (...args: unknown[]) => {
        const [delayMs] = args as [number];
        vi.setSystemTime(new Date(Date.now() + delayMs));
      });

    try {
      await expect(service.dispatch(command.commandId)).rejects.toThrow(
        "connection refused",
      );
    } finally {
      vi.useRealTimers();
    }

    expect(iotClient.start).toHaveBeenCalledTimes(4);
    expect(wait).toHaveBeenNthCalledWith(1, 1_000);
    expect(wait).toHaveBeenNthCalledWith(2, 5_000);
    expect(wait).toHaveBeenNthCalledWith(3, 20_000);
    expect(command.status).toBe(DeviceCommandStatus.FAILED);
    expect(command.session.status).toBe(ChargingSessionStatus.START_FAILED);
    expect(command.session.connector.status).toBe("AVAILABLE");
    expect(sessionRepository.save).toHaveBeenCalledWith(command.session);
    expect(connectorRepository.save).toHaveBeenCalledWith(
      command.session.connector,
    );
    expect(gateway.publishSession).toHaveBeenCalledWith(
      command.session.id,
      "session.updated",
      ChargingSessionStatus.START_FAILED,
    );
  });

  it("resumes a persisted retry at its scheduled attempt during bootstrap", async () => {
    const command = createCommand({
      retryCount: 1,
      nextAttemptAt: new Date("2026-09-08T11:00:05.000Z"),
    });
    const commandRepository = {
      find: vi.fn().mockResolvedValue([command]),
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T11:00:00.000Z"));
    const wait = vi
      .spyOn(service as never, "wait" as never)
      .mockImplementation(async (...args: unknown[]) => {
        const [delayMs] = args as [number];
        vi.setSystemTime(new Date(Date.now() + delayMs));
      });

    try {
      await service.onApplicationBootstrap();
    } finally {
      vi.useRealTimers();
    }

    expect(commandRepository.find).toHaveBeenCalledWith({
      where: { status: DeviceCommandStatus.PENDING },
    });
    expect(wait).toHaveBeenCalledWith(5_000);
    expect(iotClient.start).toHaveBeenCalledWith({
      commandId: command.commandId,
      sessionId: command.session.id,
      stationCode: "ST01",
      connectorCode: "ST01-C01",
      durationSeconds: 7200,
      expiresAt: "2026-09-08T12:00:00.000Z",
      configVersion: 1,
    });
    expect(command.retryCount).toBe(1);
    expect(command.status).toBe(DeviceCommandStatus.SENT);
    expect(command.nextAttemptAt).toBeNull();
  });

  it("marks configuration failures failed without retrying", async () => {
    const command = createCommand({
      payload: {
        configVersion: 1,
        connectorCode: "ST01-C01",
        durationSeconds: "invalid",
        expiresAt: "2026-09-08T12:00:00.000Z",
        sessionId: "session_1",
        stationCode: "ST01",
      },
    });
    const commandRepository = {
      findOne: vi.fn().mockResolvedValue(command),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const dataSource = {
      getRepository: vi.fn().mockReturnValue(commandRepository),
    };
    const iotClient = {
      start: vi.fn(),
    };
    const service = new CommandDispatcherService(
      dataSource as unknown as DataSource,
      iotClient as unknown as IotServiceClient,
    );
    const wait = vi.spyOn(service as never, "wait" as never);

    await expect(service.dispatch(command.commandId)).rejects.toThrow(
      "Persisted device command has an invalid start payload",
    );

    expect(iotClient.start).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(command.retryCount).toBe(0);
    expect(command.status).toBe(DeviceCommandStatus.FAILED);
    expect(command.nextAttemptAt).toBeNull();
  });

  it("marks an invalid persisted retry schedule failed without retrying", async () => {
    const command = createCommand({
      nextAttemptAt: new Date("invalid"),
      retryCount: 1,
    });
    const commandRepository = {
      findOne: vi.fn().mockResolvedValue(command),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const dataSource = {
      getRepository: vi.fn().mockReturnValue(commandRepository),
    };
    const iotClient = {
      start: vi.fn(),
    };
    const service = new CommandDispatcherService(
      dataSource as unknown as DataSource,
      iotClient as unknown as IotServiceClient,
    );
    const wait = vi.spyOn(service as never, "wait" as never);

    await expect(service.dispatch(command.commandId)).rejects.toThrow(
      "Persisted device command has an invalid retry schedule",
    );

    expect(iotClient.start).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(command.retryCount).toBe(1);
    expect(command.status).toBe(DeviceCommandStatus.FAILED);
    expect(command.nextAttemptAt).toBeNull();
  });

  it("marks rejected command responses failed without retrying", async () => {
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
        .mockRejectedValue(
          new IotCommandRejectedError("IoT Service rejected command"),
        ),
    };
    const service = new CommandDispatcherService(
      dataSource as unknown as DataSource,
      iotClient as unknown as IotServiceClient,
    );
    const wait = vi.spyOn(service as never, "wait" as never);

    await expect(service.dispatch(command.commandId)).rejects.toThrow(
      "IoT Service rejected command",
    );

    expect(iotClient.start).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(command.retryCount).toBe(0);
    expect(command.status).toBe(DeviceCommandStatus.FAILED);
    expect(command.nextAttemptAt).toBeNull();
  });
});

function createCommand(overrides: Partial<DeviceCommand> = {}): DeviceCommand {
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
    nextAttemptAt: null,
    ...overrides,
  } as unknown as DeviceCommand;
}
