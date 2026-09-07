import { ForbiddenException, Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { DataSource } from "typeorm";

import {
  ChargingSession,
  ChargingSessionStatus,
  Connector,
  DeviceCommand,
  DeviceCommandStatus,
} from "../database/data-source.js";
import type { CommandDispatcherService } from "../iot/command-dispatcher.service.js";
import type { ChargeGateway } from "../realtime/charge.gateway.js";
import { ChargingController } from "./charging.controller.js";
import { ChargingService } from "./charging.service.js";

describe("ChargingController", () => {
  it("returns an estimated remaining time without claiming it controls the device timer", async () => {
    const chargeGateway = {
      authorizeSession: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new ChargingController(
      {
        getSession: async () => ({
          id: "ses_1",
          status: "CHARGING",
          estimatedRemainingSeconds: 3450,
          timerAuthority: "DEVICE",
        }),
      } as unknown as ChargingService,
      chargeGateway as unknown as ChargeGateway,
    );

    const response = await controller.getSession("ses_1", "Bearer access");

    expect(response).toMatchObject({
      id: "ses_1",
      status: "CHARGING",
      estimatedRemainingSeconds: 3450,
      timerAuthority: "DEVICE",
    });
    expect(chargeGateway.authorizeSession).toHaveBeenCalledWith(
      "ses_1",
      "access",
    );
  });

  it("uses only the persisted device observation for the remaining-time estimate", async () => {
    const repository = {
      findOneBy: async () => ({
        id: "ses_1",
        status: "CHARGING",
        expectedEndAt: new Date("2026-09-08T13:00:00.000Z"),
        estimatedRemainingSeconds: 3450,
        lastDeviceEventAt: new Date("2026-09-08T12:02:30.000Z"),
        operationalWarning: null,
        order: { id: "ord_1" },
      }),
    };
    const service = new ChargingService({
      getRepository: () => repository,
    } as unknown as DataSource);

    await expect(service.getSession("ses_1")).resolves.toMatchObject({
      id: "ses_1",
      orderId: "ord_1",
      status: "CHARGING",
      estimatedRemainingSeconds: 3450,
      timerAuthority: "DEVICE",
      lastDeviceEventAt: "2026-09-08T12:02:30.000Z",
    });
  });

  it("returns 401 without a session access token and does not queue a stop command", async () => {
    const chargingService = {
      stopSession: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const controller = new ChargingController(
      chargingService as unknown as ChargingService,
      { authorizeSession: vi.fn() } as unknown as ChargeGateway,
    );

    await expect(
      controller.stopSession("ses_1", undefined),
    ).rejects.toMatchObject({ status: 401 });
    expect(chargingService.stopSession).not.toHaveBeenCalled();
  });

  it("returns 403 when the signed session access token cannot authorize the session", async () => {
    const chargingService = {
      stopSession: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const gateway = {
      authorizeSession: vi
        .fn()
        .mockRejectedValue(
          new ForbiddenException("Session access token does not match order"),
        ),
    };
    const controller = new ChargingController(
      chargingService as unknown as ChargingService,
      gateway as unknown as ChargeGateway,
    );

    await expect(
      controller.stopSession("ses_1", "Bearer token-for-another-order"),
    ).rejects.toMatchObject({ status: 403 });
    expect(gateway.authorizeSession).toHaveBeenCalledWith(
      "ses_1",
      "token-for-another-order",
    );
    expect(chargingService.stopSession).not.toHaveBeenCalled();
  });

  it("authorizes a retry-start with the order capability before dispatching recovery", async () => {
    const chargingService = {
      retryStart: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const gateway = {
      authorizeSession: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new ChargingController(
      chargingService as unknown as ChargingService,
      gateway as unknown as ChargeGateway,
    );

    await expect(
      controller.retryStart("ses_1", "Bearer order-capability"),
    ).resolves.toEqual({ accepted: true });

    expect(gateway.authorizeSession).toHaveBeenCalledWith(
      "ses_1",
      "order-capability",
    );
    expect(chargingService.retryStart).toHaveBeenCalledWith("ses_1");
  });

  it("reuses the original failed start command and payload during recovery", async () => {
    const expiry = new Date(Date.now() + 60 * 60_000).toISOString();
    const originalPayload = {
      stationCode: "ST01",
      connectorCode: "ST01-C01",
      deviceId: "dev_ST01",
      sessionId: "ses_1",
      durationSeconds: 7200,
      expiresAt: expiry,
      configVersion: 1,
    };
    const session = {
      id: "ses_1",
      status: ChargingSessionStatus.START_FAILED,
      startedAt: null,
      stoppedAt: null,
      expectedEndAt: new Date(expiry),
      connector: {
        id: "con_1",
        code: "ST01-C01",
        status: "AVAILABLE",
      },
    } as ChargingSession;
    const command = {
      id: "cmd_row_1",
      commandId: "cmd_start_1",
      commandType: "START_CHARGING",
      session,
      payload: originalPayload,
      retryCount: 3,
      nextAttemptAt: new Date("2026-09-08T10:00:00.000Z"),
      status: DeviceCommandStatus.FAILED,
      acknowledgedAt: new Date("2026-09-08T10:00:00.000Z"),
    } as DeviceCommand;
    const sessionRepository = {
      findOneBy: vi.fn().mockResolvedValue(session),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const commandRepository = {
      findOne: vi.fn().mockResolvedValue(command),
      create: vi.fn(),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const connectorRepository = {
      findOne: vi.fn().mockResolvedValue(session.connector),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const manager = {
      query: vi.fn().mockImplementation(async (query: string) => {
        if (query.includes("FROM charging_sessions"))
          return [{ id: session.id }];
        if (query.includes("FROM connectors")) {
          return [{ id: session.connector.id }];
        }
        throw new Error("Unexpected lock query");
      }),
      getRepository: vi.fn((entity) => {
        if (entity === ChargingSession) return sessionRepository;
        if (entity === DeviceCommand) return commandRepository;
        if (entity === Connector) return connectorRepository;
        throw new Error("Unexpected repository");
      }),
    };
    const dataSource = {
      transaction: vi.fn(async (callback) => callback(manager)),
    };
    const dispatcher = { dispatch: vi.fn().mockResolvedValue(undefined) };
    const service = new ChargingService(
      dataSource as unknown as DataSource,
      dispatcher as unknown as CommandDispatcherService,
    );

    await expect(service.retryStart(session.id)).resolves.toEqual({
      accepted: true,
    });

    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM charging_sessions"),
      [session.id],
    );
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM connectors"),
      [session.connector.id],
    );
    expect(commandRepository.create).not.toHaveBeenCalled();
    expect(command.commandId).toBe("cmd_start_1");
    expect(command.payload).toEqual(originalPayload);
    expect(command).toMatchObject({
      retryCount: 0,
      nextAttemptAt: null,
      status: DeviceCommandStatus.PENDING,
      acknowledgedAt: null,
    });
    expect(session.status).toBe(ChargingSessionStatus.PENDING);
    expect(session.connector.status).toBe("OCCUPIED");
    expect(dispatcher.dispatch).toHaveBeenCalledWith("cmd_start_1");
  });

  it.each([
    {
      name: "expired original payload",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      connectorStatus: "AVAILABLE",
    },
    {
      name: "occupied connector",
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      connectorStatus: "OCCUPIED",
    },
  ])(
    "rejects retry-start with a $name",
    async ({ expiresAt, connectorStatus }) => {
      const session = {
        id: "ses_1",
        status: ChargingSessionStatus.START_FAILED,
        startedAt: null,
        stoppedAt: null,
        expectedEndAt: new Date(Date.now() + 60 * 60_000),
        connector: {
          id: "con_1",
          status: connectorStatus,
        },
      } as ChargingSession;
      const command = {
        commandId: "cmd_start_1",
        commandType: "START_CHARGING",
        session,
        payload: {
          stationCode: "ST01",
          connectorCode: "ST01-C01",
          deviceId: "dev_ST01",
          sessionId: session.id,
          durationSeconds: 7200,
          expiresAt,
          configVersion: 1,
        },
        retryCount: 3,
        status: DeviceCommandStatus.FAILED,
      } as DeviceCommand;
      const sessionRepository = {
        findOneBy: vi.fn().mockResolvedValue(session),
        save: vi.fn(),
      };
      const commandRepository = {
        findOne: vi.fn().mockResolvedValue(command),
        save: vi.fn(),
      };
      const connectorRepository = {
        findOne: vi.fn().mockResolvedValue(session.connector),
        save: vi.fn(),
      };
      const manager = {
        query: vi.fn().mockImplementation(async (query: string) => {
          if (query.includes("FROM charging_sessions"))
            return [{ id: session.id }];
          if (query.includes("FROM connectors")) {
            return [{ id: session.connector.id }];
          }
          throw new Error("Unexpected lock query");
        }),
        getRepository: vi.fn((entity) => {
          if (entity === ChargingSession) return sessionRepository;
          if (entity === DeviceCommand) return commandRepository;
          if (entity === Connector) return connectorRepository;
          throw new Error("Unexpected repository");
        }),
      };
      const service = new ChargingService({
        transaction: async (callback) => callback(manager),
      } as unknown as DataSource);

      await expect(service.retryStart(session.id)).rejects.toThrow();
      expect(commandRepository.save).not.toHaveBeenCalled();
      expect(sessionRepository.save).not.toHaveBeenCalled();
      expect(connectorRepository.save).not.toHaveBeenCalled();
    },
  );

  it("locks a charging session and moves it to STOPPING with its stop command", async () => {
    const session = {
      id: "ses_1",
      status: ChargingSessionStatus.CHARGING,
      connector: {
        code: "ST01-C01",
        station: { code: "ST01", deviceId: "dev_ST01" },
      },
    } as ChargingSession;
    const sessionRepository = {
      findOneBy: vi.fn().mockResolvedValue(session),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const commandRepository = {
      findOne: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation((entity) => entity),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const manager = {
      query: vi.fn().mockResolvedValue([{ id: session.id }]),
      getRepository: vi.fn((entity) => {
        if (entity === ChargingSession) return sessionRepository;
        if (entity === DeviceCommand) return commandRepository;
        throw new Error("Unexpected repository");
      }),
    };
    let transactionCommitted = false;
    const dataSource = {
      transaction: vi.fn(async (callback) => {
        const result = await callback(manager);
        transactionCommitted = true;
        return result;
      }),
    };
    const dispatcher = {
      dispatch: vi.fn(async () => {
        expect(transactionCommitted).toBe(true);
      }),
    };
    const service = new ChargingService(
      dataSource as unknown as DataSource,
      dispatcher as unknown as CommandDispatcherService,
    );

    await expect(service.stopSession("ses_1")).resolves.toEqual({
      accepted: true,
    });

    expect(commandRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        commandType: "STOP_CHARGING",
        payload: { sessionId: "ses_1", reason: "USER_REQUESTED" },
        status: DeviceCommandStatus.PENDING,
      }),
    );
    expect(commandRepository.save).toHaveBeenCalledTimes(1);
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM charging_sessions"),
      [session.id],
    );
    expect(sessionRepository.save).toHaveBeenCalledWith(session);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      commandRepository.create.mock.results[0]?.value.commandId,
    );
    expect(session.status).toBe(ChargingSessionStatus.STOPPING);
  });

  it("returns accepted before a slow dispatcher completes", async () => {
    const { commandRepository, service } = createStopHarness(
      () => new Promise<void>(() => undefined),
    );

    const response = await Promise.race([
      service.stopSession("ses_1"),
      new Promise<"timed out">((resolve) => {
        setTimeout(() => resolve("timed out"), 25);
      }),
    ]);

    expect(commandRepository.save).toHaveBeenCalledTimes(1);
    expect(response).toEqual({ accepted: true });
  });

  it("returns accepted and safely logs when asynchronous dispatch rejects", async () => {
    const logger = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const { service } = createStopHarness(async () => {
      throw new Error("dispatcher unavailable");
    });

    await expect(service.stopSession("ses_1")).resolves.toEqual({
      accepted: true,
    });
    await vi.waitFor(() => {
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining("Failed to dispatch stop command"),
        expect.any(String),
      );
    });
    logger.mockRestore();
  });
});

function createStopHarness(dispatch: (commandId: string) => Promise<void>) {
  const session = {
    id: "ses_1",
    status: ChargingSessionStatus.CHARGING,
  } as ChargingSession;
  const commandRepository = {
    findOne: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockImplementation((entity) => entity),
    save: vi.fn().mockImplementation(async (entity) => entity),
  };
  const manager = {
    query: vi.fn().mockResolvedValue([{ id: session.id }]),
    getRepository: vi.fn((entity) => {
      if (entity === ChargingSession) {
        return {
          findOneBy: vi.fn().mockResolvedValue(session),
          save: vi.fn().mockImplementation(async (entity) => entity),
        };
      }
      if (entity === DeviceCommand) return commandRepository;
      throw new Error("Unexpected repository");
    }),
  };
  const dataSource = {
    transaction: vi.fn(async (callback) => callback(manager)),
  };

  return {
    commandRepository,
    service: new ChargingService(
      dataSource as unknown as DataSource,
      { dispatch } as unknown as CommandDispatcherService,
    ),
  };
}
