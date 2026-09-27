import { describe, expect, it, vi } from "vitest";
import type { DataSource } from "typeorm";

import {
  ChargingSession,
  ChargingSessionStatus,
  Connector,
  ConnectorStatus,
  DeviceAvailability,
  DeviceCommand,
  DeviceEvent,
  DeviceCommandStatus,
  OrderStatus,
  PaymentTransaction,
  PaymentTransactionStatus,
  PricingPlan,
  ManagedDevice,
  Station,
} from "../database/data-source.js";
import { AdminService } from "./admin.service.js";
import type { CoreIotClient } from "../iot/core-iot.client.js";
import type { StationQrService } from "../stations/station-qr.service.js";

describe("AdminService", () => {
  it("links an unassigned station to one unique device", async () => {
    const station = {
      id: "station-1",
      code: "ST01",
      name: "Riverside",
      deviceId: null,
    } as Station;
    const stationRepository = {
      findOneBy: vi
        .fn()
        .mockResolvedValueOnce(station)
        .mockResolvedValueOnce(null),
      save: vi.fn().mockImplementation(async (value) => value),
    };
    const deviceRepository = {
      findOneBy: vi.fn().mockResolvedValue(null),
      create: vi.fn((input) => input),
      save: vi.fn().mockImplementation(async (value) => value),
    };
    const service = new AdminService(
      {
        transaction: vi.fn(async (callback) =>
          callback({
            getRepository: (entity: unknown) =>
              entity === ManagedDevice ? deviceRepository : stationRepository,
          }),
        ),
      } as unknown as DataSource,
      {} as StationQrService,
      {} as CoreIotClient,
    );

    await expect(service.linkDevice("station-1", "core-device-1")).resolves.toMatchObject({
      id: "station-1",
      deviceId: "core-device-1",
      status: "UNAVAILABLE",
    });
    expect(stationRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: "core-device-1" }),
    );
  });

  it("attaches Core telemetry to mapped station", async () => {
    const station = {
      id: "station-1",
      code: "ST01",
      name: "Demo Station",
      deviceId: "core-device",
    } as Station;
    const core = {
      latestTelemetry: vi.fn().mockResolvedValue({
        eventAt: new Date().toISOString(),
        relayState: true,
        voltageV: 230.4,
        currentA: 10.2,
        powerW: 2350,
        energyKwh: 0.0174,
        remainingSeconds: 3540,
      }),
    };
    const managedDevice = {
      deviceId: "core-device",
      availability: DeviceAvailability.AVAILABLE,
    } as ManagedDevice;
    const admin = new AdminService(
      {
        getRepository: (entity: unknown) => {
          if (entity === ManagedDevice) return { find: vi.fn().mockResolvedValue([managedDevice]) };
          if (entity === Station) return { find: vi.fn().mockResolvedValue([station]) };
          if (entity === Connector) return { find: vi.fn().mockResolvedValue([]) };
          if (entity === ChargingSession) return { find: vi.fn().mockResolvedValue([]) };
          throw new Error("Unexpected repository");
        },
      } as unknown as DataSource,
      {} as StationQrService,
      core as unknown as CoreIotClient,
    );

    await expect(admin.getStations()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deviceId: "core-device",
          status: "AVAILABLE",
          telemetry: expect.objectContaining({
            status: "AVAILABLE",
            voltageV: 230.4,
            powerW: 2350,
          }),
        }),
      ]),
    );
  });

  it("marks a station unavailable when its available device telemetry is stale", async () => {
    const station = {
      id: "station-1",
      code: "ST01",
      name: "Demo Station",
      deviceId: "core-device",
    } as Station;
    const admin = new AdminService(
      {
        getRepository: (entity: unknown) => {
          if (entity === ManagedDevice) {
            return {
              find: vi.fn().mockResolvedValue([{
                deviceId: "core-device",
                availability: DeviceAvailability.AVAILABLE,
              }]),
            };
          }
          if (entity === Station) return { find: vi.fn().mockResolvedValue([station]) };
          if (entity === Connector) return { find: vi.fn().mockResolvedValue([]) };
          if (entity === ChargingSession) return { find: vi.fn().mockResolvedValue([]) };
          throw new Error("Unexpected repository");
        },
      } as unknown as DataSource,
      {} as StationQrService,
      {
        latestTelemetry: vi.fn().mockResolvedValue({
          eventAt: new Date(Date.now() - 90_001).toISOString(),
        }),
      } as unknown as CoreIotClient,
    );

    await expect(admin.getStations()).resolves.toEqual([
      expect.objectContaining({ status: "UNAVAILABLE" }),
    ]);
  });

  it("summarizes live connectors, today's paid revenue, and operational alerts", async () => {
    const now = new Date();
    const station = {
      id: "station-1",
      code: "ST01",
      name: "Demo Station",
      deviceId: "dev_ST01",
      connectors: [],
    } as Station;
    const available = {
      id: "connector-1",
      code: "ST01-C01",
      status: ConnectorStatus.AVAILABLE,
      station,
    } as Connector;
    const offline = {
      id: "connector-2",
      code: "ST01-C02",
      status: ConnectorStatus.OFFLINE,
      station,
    } as Connector;
    const chargingSession = {
      id: "session-1",
      status: ChargingSessionStatus.CHARGING,
      connector: available,
      order: {
        id: "order-1",
        status: OrderStatus.PAID,
        amountVnd: 10_000,
        durationMinutes: 120,
        createdAt: now,
      },
      startedAt: new Date(now.valueOf() - 30 * 60_000),
      expectedEndAt: new Date(now.valueOf() + 90 * 60_000),
      stoppedAt: null,
      estimatedRemainingSeconds: 5_400,
      lastDeviceEventAt: now,
      operationalWarning: null,
    } as ChargingSession;
    const offlineSession = {
      ...chargingSession,
      id: "session-2",
      connector: offline,
      status: ChargingSessionStatus.DEVICE_OFFLINE,
      operationalWarning: "Device heartbeat has timed out",
    } as ChargingSession;
    const paidPayment = {
      id: "payment-1",
      status: PaymentTransactionStatus.PAID,
      order: chargingSession.order,
      updatedAt: now,
    } as PaymentTransaction;
    const pendingPayment = {
      id: "payment-2",
      status: PaymentTransactionStatus.PENDING,
      order: chargingSession.order,
      updatedAt: now,
    } as PaymentTransaction;

    const repositoryByEntity = new Map([
      [Station, { find: vi.fn().mockResolvedValue([station]) }],
      [Connector, { find: vi.fn().mockResolvedValue([available, offline]) }],
      [
        ChargingSession,
        { find: vi.fn().mockResolvedValue([chargingSession, offlineSession]) },
      ],
      [
        PaymentTransaction,
        { find: vi.fn().mockResolvedValue([paidPayment, pendingPayment]) },
      ],
      [DeviceCommand, { find: vi.fn().mockResolvedValue([]) }],
      [DeviceEvent, { find: vi.fn().mockResolvedValue([]) }],
    ]);
    const service = new AdminService(
      {
        getRepository: (entity: unknown) => repositoryByEntity.get(entity),
      } as unknown as DataSource,
      {} as StationQrService,
    );

    await expect(service.getOverview()).resolves.toMatchObject({
      stations: 1,
      connectors: {
        total: 2,
        available: 1,
        offline: 1,
      },
      sessions: {
        active: 2,
        charging: 1,
        attention: 1,
      },
      revenueTodayVnd: 10_000,
      paymentsPending: 1,
      alerts: [
        expect.objectContaining({
          category: "CONNECTOR_OFFLINE",
          connectorCode: "ST01-C02",
        }),
        expect.objectContaining({
          category: "DEVICE_OFFLINE",
          sessionId: "session-2",
        }),
      ],
    });
  });

  it("keeps the device timeline actionable by omitting heartbeat noise", async () => {
    const now = new Date("2026-09-10T01:00:00.000Z");
    const session = {
      id: "session-1",
      connector: { code: "ST01-C01" },
    } as ChargingSession;
    const service = new AdminService(
      {
        getRepository: (entity: unknown) => {
          if (entity === DeviceCommand) {
            return { find: vi.fn().mockResolvedValue([]) };
          }
          if (entity === DeviceEvent) {
            return {
              find: vi.fn().mockResolvedValue([
                {
                  id: "heartbeat-1",
                  eventType: "HEARTBEAT",
                  occurredAt: now,
                  connectorCode: "ST01-C01",
                  session,
                  processedAt: now,
                  payload: { remainingSeconds: 60 },
                },
                {
                  id: "stopped-1",
                  eventType: "STOPPED",
                  occurredAt: new Date(now.valueOf() - 1_000),
                  connectorCode: "ST01-C01",
                  session,
                  processedAt: now,
                  payload: { relayState: "OFF" },
                },
              ]),
            };
          }
          throw new Error("Unexpected repository");
        },
      } as unknown as DataSource,
      {} as StationQrService,
    );

    await expect(service.getDeviceTimeline()).resolves.toEqual([
      expect.objectContaining({
        id: "stopped-1",
        kind: "EVENT",
        type: "STOPPED",
      }),
    ]);
  });

  it("creates a station with an internal default connector derived from its code", async () => {
    const stationRepository = {
      findOneBy: vi.fn().mockResolvedValue(null),
      create: vi.fn((input) => input),
      save: vi.fn().mockImplementation(async (input) => input),
    };
    const connectorRepository = {
      findOneBy: vi.fn().mockResolvedValue(null),
      create: vi.fn((input) => input),
      save: vi.fn().mockImplementation(async (input) => input),
    };
    const pricingRepository = {
      find: vi.fn().mockResolvedValue([
        { id: "price-1", name: "MVP hourly pricing" },
      ]),
    };
    const deviceRepository = {
      findOneBy: vi.fn().mockResolvedValue(null),
      create: vi.fn((input) => input),
      save: vi.fn().mockImplementation(async (input) => input),
    };
    const manager = {
      getRepository: (entity: unknown) => {
        if (entity === Station) return stationRepository;
        if (entity === Connector) return connectorRepository;
        if (entity === PricingPlan) return pricingRepository;
        if (entity === ManagedDevice) return deviceRepository;
        throw new Error("Unexpected repository");
      },
    };
    const dataSource = {
      transaction: vi.fn(async (callback) => callback(manager)),
    };
    const service = new AdminService(
      dataSource as unknown as DataSource,
      {
        issue: vi.fn().mockReturnValue({
          token: "encrypted-token",
          url: "https://charge.example.test/scan/station/encrypted-token",
        }),
      } as unknown as StationQrService,
    );

    await expect(
      service.createStation({
        code: "ST02",
        deviceId: "dev_ST02",
      }),
    ).resolves.toMatchObject({
      code: "ST02",
      name: "ST02",
      qrVersion: 1,
      connectors: [expect.objectContaining({ code: "ST02-C01" })],
    });

    expect(stationRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "ST02",
        deviceId: "dev_ST02",
        qrVersion: 1,
      }),
    );
    expect(connectorRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "ST02-C01",
        status: ConnectorStatus.AVAILABLE,
        pricingPlan: { id: "price-1", name: "MVP hourly pricing" },
      }),
    );
  });

  it("rotates the QR version and only returns the freshly encrypted station URL", async () => {
    const station = {
      id: "station-1",
      code: "ST01",
      name: "Demo Station",
      qrVersion: 1,
    } as Station;
    const stationRepository = {
      findOneBy: vi.fn().mockResolvedValue(station),
      save: vi.fn().mockImplementation(async (input) => input),
    };
    const issue = vi.fn().mockReturnValue({
      token: "ciphertext",
      url: "https://charge.example.test/scan/station/ciphertext",
    });
    const service = new AdminService(
      {
        transaction: vi.fn(async (callback) =>
          callback({ getRepository: () => stationRepository }),
        ),
      } as unknown as DataSource,
      { issue } as unknown as StationQrService,
    );

    await expect(service.rotateStationQr(station.id)).resolves.toEqual({
      stationId: station.id,
      qrVersion: 2,
      scanUrl: "https://charge.example.test/scan/station/ciphertext",
    });
    expect(issue).toHaveBeenCalledWith(
      station.id,
      2,
      expect.objectContaining({ getRepository: expect.any(Function) }),
    );
  });
});
