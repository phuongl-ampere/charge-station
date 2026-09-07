import { randomUUID } from "node:crypto";

import { Logger } from "@nestjs/common";
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

  it("marks exhausted start transport retries as state-unknown without releasing the connector", async () => {
    const command = createCommand();
    const commandRepository = {
      findOne: vi.fn().mockResolvedValue(command),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const sessionRepository = {
      findOneBy: vi.fn().mockResolvedValue(command.session),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const manager = {
      query: vi.fn().mockImplementation(async (query: string) => {
        if (query.includes("FROM charging_sessions")) {
          return [{ id: command.session.id }];
        }
        throw new Error("Unexpected lock query");
      }),
      getRepository: vi.fn((entity) => {
        if (entity === DeviceCommand) return commandRepository;
        if (entity === ChargingSession) return sessionRepository;
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
    expect(command.session.status).toBe(ChargingSessionStatus.DEVICE_OFFLINE);
    expect(command.session.operationalWarning).toBe("START_STATE_UNKNOWN");
    expect(command.session.connector.status).toBe("OCCUPIED");
    expect(sessionRepository.save).toHaveBeenCalledWith(command.session);
    expect(manager.query).not.toHaveBeenCalledWith(
      expect.stringContaining("FROM connectors"),
      expect.anything(),
    );
    expect(gateway.publishSession).toHaveBeenCalledWith(
      command.session.id,
      "session.updated",
      ChargingSessionStatus.DEVICE_OFFLINE,
    );
  });

  it("does not dispatch pending IoT commands during application bootstrap", async () => {
    const commandRepository = {
      find: vi.fn().mockResolvedValue([]),
    };
    const dataSource = {
      getRepository: vi.fn().mockReturnValue(commandRepository),
    };
    const service = new CommandDispatcherService(
      dataSource as unknown as DataSource,
      {} as IotServiceClient,
    );

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(commandRepository.find).not.toHaveBeenCalled();
  });

  it("keeps a directly queued start command pending until IoT health recovers", async () => {
    const command = createCommand();
    const commandRepository = {
      findOne: vi.fn().mockResolvedValue(command),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const dataSource = {
      getRepository: vi.fn().mockReturnValue(commandRepository),
    };
    const iotClient = {
      isHealthy: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      start: vi.fn().mockResolvedValue(undefined),
    };
    const service = new CommandDispatcherService(
      dataSource as unknown as DataSource,
      iotClient as unknown as IotServiceClient,
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T11:00:00.000Z"));
    try {
      service.dispatchWhenIotReady(command.commandId);
      await Promise.resolve();
      await Promise.resolve();

      expect(iotClient.isHealthy).toHaveBeenCalledTimes(1);
      expect(iotClient.start).not.toHaveBeenCalled();
      expect(command).toMatchObject({
        status: DeviceCommandStatus.PENDING,
        retryCount: 0,
        nextAttemptAt: null,
      });
      expect(commandRepository.save).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(250);

      expect(iotClient.isHealthy).toHaveBeenCalledTimes(2);
      expect(iotClient.start).toHaveBeenCalledTimes(1);
      expect(command).toMatchObject({
        status: DeviceCommandStatus.SENT,
        retryCount: 0,
        nextAttemptAt: null,
      });
    } finally {
      service.onApplicationShutdown();
      vi.useRealTimers();
    }
  });

  it("continues draining ready commands after one queued dispatch fails", async () => {
    const dataSource = {
      getRepository: vi.fn(),
    };
    const iotClient = {
      isHealthy: vi.fn().mockResolvedValue(true),
    };
    const service = new CommandDispatcherService(
      dataSource as unknown as DataSource,
      iotClient as unknown as IotServiceClient,
    );
    const dispatch = vi
      .spyOn(service, "dispatch")
      .mockRejectedValueOnce(new Error("first command is invalid"))
      .mockResolvedValueOnce(undefined);
    const logger = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);

    try {
      service.dispatchWhenIotReady("command_1");
      service.dispatchWhenIotReady("command_2");
      await vi.waitFor(() => {
        expect(dispatch).toHaveBeenCalledTimes(2);
      });
    } finally {
      logger.mockRestore();
    }

    expect(dispatch).toHaveBeenNthCalledWith(1, "command_1");
    expect(dispatch).toHaveBeenNthCalledWith(2, "command_2");
  });

  it("retries the post-listen IoT readiness probe before dispatching pending commands", async () => {
    const command = createCommand();
    const commandRepository = {
      find: vi.fn().mockResolvedValue([command]),
    };
    const dataSource = {
      getRepository: vi.fn().mockReturnValue(commandRepository),
    };
    const iotClient = {
      isHealthy: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    };
    const service = new CommandDispatcherService(
      dataSource as unknown as DataSource,
      iotClient as unknown as IotServiceClient,
    );
    const dispatch = vi.spyOn(service, "dispatch").mockResolvedValue(undefined);
    const readyDispatcher = service as unknown as {
      dispatchPendingAfterReady(): void;
    };

    vi.useFakeTimers();
    try {
      readyDispatcher.dispatchPendingAfterReady();
      await Promise.resolve();
      await Promise.resolve();

      expect(iotClient.isHealthy).toHaveBeenCalledTimes(1);
      expect(commandRepository.find).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(249);
      expect(iotClient.isHealthy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(iotClient.isHealthy).toHaveBeenCalledTimes(2);
      expect(commandRepository.find).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(499);
      expect(iotClient.isHealthy).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(iotClient.isHealthy).toHaveBeenCalledTimes(3);
      expect(commandRepository.find).toHaveBeenCalledWith({
        where: { status: DeviceCommandStatus.PENDING },
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith(command.commandId);
      expect(command.retryCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a pending start command at retry zero until the Compose IoT dependency is healthy", async () => {
    const command = createCommand();
    const commandRepository = {
      find: vi.fn().mockResolvedValue([command]),
      findOne: vi.fn().mockResolvedValue(command),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const dataSource = {
      getRepository: vi.fn().mockReturnValue(commandRepository),
    };
    const iotClient = {
      isHealthy: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      start: vi.fn().mockResolvedValue(undefined),
    };
    const service = new CommandDispatcherService(
      dataSource as unknown as DataSource,
      iotClient as unknown as IotServiceClient,
    );
    const readyDispatcher = service as unknown as {
      dispatchPendingAfterReady(): void;
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T11:00:00.000Z"));
    try {
      readyDispatcher.dispatchPendingAfterReady();
      await Promise.resolve();
      await Promise.resolve();

      expect(command.retryCount).toBe(0);
      expect(command.status).toBe(DeviceCommandStatus.PENDING);
      expect(commandRepository.find).not.toHaveBeenCalled();
      expect(iotClient.start).not.toHaveBeenCalled();
      expect(commandRepository.save).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(250);

      expect(iotClient.isHealthy).toHaveBeenCalledTimes(2);
      expect(iotClient.start).toHaveBeenCalledTimes(1);
      expect(command.retryCount).toBe(0);
      expect(command.status).toBe(DeviceCommandStatus.SENT);
      expect(commandRepository.save).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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

  it.each([
    ["a canonical expired timestamp", "2026-09-08T10:00:00.000Z", null],
    ["a noncanonical ISO timestamp", "2026-09-08T12:00:00+00:00", null],
    [
      "a timestamp that expires while waiting for its scheduled retry",
      "2026-09-08T11:00:00.500Z",
      new Date("2026-09-08T11:00:01.000Z"),
    ],
  ])(
    "settles a pending start command with %s as a definitive failure",
    async (_name, expiresAt, nextAttemptAt) => {
      const command = createCommand({
        nextAttemptAt,
        payload: {
          ...createCommand().payload,
          expiresAt,
        },
      });
      command.payload.sessionId = command.session.id;
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
        start: vi.fn(),
      };
      const service = new CommandDispatcherService(
        dataSource as unknown as DataSource,
        iotClient as unknown as IotServiceClient,
      );
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-08T11:00:00.000Z"));
      vi.spyOn(service as never, "wait" as never).mockImplementation(
        async (...args: unknown[]) => {
          const [delayMs] = args as [number];
          vi.setSystemTime(new Date(Date.now() + delayMs));
        },
      );

      try {
        await expect(service.dispatch(command.commandId)).rejects.toThrow(
          "Persisted device command has an expired or invalid start expiry",
        );
      } finally {
        vi.useRealTimers();
      }

      expect(iotClient.start).not.toHaveBeenCalled();
      expect(command.status).toBe(DeviceCommandStatus.FAILED);
      expect(command.session.status).toBe(ChargingSessionStatus.START_FAILED);
      expect(command.session.connector.status).toBe("AVAILABLE");
      expect(sessionRepository.save).toHaveBeenCalledWith(command.session);
      expect(connectorRepository.save).toHaveBeenCalledWith(
        command.session.connector,
      );
    },
  );

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

  it("treats a rejected start command as definitive and releases the connector", async () => {
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
    expect(command.session.status).toBe(ChargingSessionStatus.START_FAILED);
    expect(command.session.connector.status).toBe("AVAILABLE");
    expect(sessionRepository.save).toHaveBeenCalledWith(command.session);
    expect(connectorRepository.save).toHaveBeenCalledWith(
      command.session.connector,
    );
  });
});

function createCommand(overrides: Partial<DeviceCommand> = {}): DeviceCommand {
  const connector = {
    id: randomUUID(),
    code: "ST01-C01",
    status: "OCCUPIED",
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
