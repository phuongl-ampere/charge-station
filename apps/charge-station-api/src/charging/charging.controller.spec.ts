import { ForbiddenException, Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { DataSource } from "typeorm";

import {
  ChargingSession,
  ChargingSessionStatus,
  DeviceCommand,
  DeviceCommandStatus,
} from "../database/data-source.js";
import type { CommandDispatcherService } from "../iot/command-dispatcher.service.js";
import type { ChargeGateway } from "../realtime/charge.gateway.js";
import { ChargingController } from "./charging.controller.js";
import { ChargingService } from "./charging.service.js";

describe("ChargingController", () => {
  it("returns an estimated remaining time without claiming it controls the device timer", async () => {
    const controller = new ChargingController(
      {
        getSession: async () => ({
          id: "ses_1",
          status: "CHARGING",
          estimatedRemainingSeconds: 3450,
          timerAuthority: "DEVICE",
        }),
      } as unknown as ChargingService,
      {} as ChargeGateway,
    );

    const response = await controller.getSession("ses_1");

    expect(response).toMatchObject({
      id: "ses_1",
      status: "CHARGING",
      estimatedRemainingSeconds: 3450,
      timerAuthority: "DEVICE",
    });
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

  it("queues a stop command after persistence without changing session state", async () => {
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
    };
    const commandRepository = {
      findOne: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation((entity) => entity),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const manager = {
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
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      commandRepository.create.mock.results[0]?.value.commandId,
    );
    expect(session.status).toBe(ChargingSessionStatus.CHARGING);
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
    getRepository: vi.fn((entity) => {
      if (entity === ChargingSession) {
        return { findOneBy: vi.fn().mockResolvedValue(session) };
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
