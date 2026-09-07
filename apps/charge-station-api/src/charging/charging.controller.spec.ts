import { describe, expect, it, vi } from "vitest";
import type { DataSource } from "typeorm";

import {
  ChargingSession,
  ChargingSessionStatus,
  DeviceCommand,
  DeviceCommandStatus,
} from "../database/data-source.js";
import type { CommandDispatcherService } from "../iot/command-dispatcher.service.js";
import { ChargingController } from "./charging.controller.js";
import { ChargingService } from "./charging.service.js";

describe("ChargingController", () => {
  it("returns an estimated remaining time without claiming it controls the device timer", async () => {
    const controller = new ChargingController({
      getSession: async () => ({
        id: "ses_1",
        status: "CHARGING",
        estimatedRemainingSeconds: 3450,
        timerAuthority: "DEVICE",
      }),
    } as unknown as ChargingService);

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
});
