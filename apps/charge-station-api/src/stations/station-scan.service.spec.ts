import { NotFoundException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Repository } from "typeorm";

import {
  Connector,
  ConnectorStatus,
  DeviceAvailability,
  ManagedDevice,
  Station,
} from "../database/data-source.js";
import { StationQrService } from "./station-qr.service.js";
import { StationScanService } from "./station-scan.service.js";

describe("StationScanService", () => {
  const originalKey = process.env.STATION_QR_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.STATION_QR_ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.STATION_QR_ENCRYPTION_KEY;
    } else {
      process.env.STATION_QR_ENCRYPTION_KEY = originalKey;
    }
  });

  it("resolves an encrypted station QR to selectable connectors", async () => {
    const station = {
      id: "3d20d6e7-5cbe-4fa2-af18-e8d1ab0ddbe6",
      code: "ST01",
      name: "Riverside Station",
      deviceId: "core-device-1",
      qrVersion: 2,
    } as Station;
    const connector = {
      id: "connector-1",
      code: "ST01-C01",
      status: ConnectorStatus.AVAILABLE,
      station,
      pricingPlan: {
        hourlyPriceVnd: 5_000,
        allowedDurationsMinutes: [60, 120],
      },
    } as Connector;
    const stationRepository = {
      findOneBy: vi.fn().mockResolvedValue(station),
    } as unknown as Repository<Station>;
    const connectorRepository = {
      find: vi.fn().mockResolvedValue([connector]),
    } as unknown as Repository<Connector>;
    const deviceRepository = {
      findOneBy: vi.fn().mockResolvedValue({
        deviceId: "core-device-1",
        availability: DeviceAvailability.AVAILABLE,
      } as ManagedDevice),
    } as unknown as Repository<ManagedDevice>;
    const core = {
      latestTelemetry: vi.fn().mockResolvedValue({
        eventAt: new Date().toISOString(),
      }),
    };
    const qrService = new StationQrService(createTokenRepository() as never);
    const service = new StationScanService(
      stationRepository,
      connectorRepository,
      deviceRepository,
      qrService,
      core,
    );
    const { token } = await qrService.issue(station.id, station.qrVersion);

    await expect(service.getStationScan(token)).resolves.toEqual({
      stationName: "Riverside Station",
      connectors: [
        {
          connectorCode: "ST01-C01",
          status: "AVAILABLE",
          allowedDurationsMinutes: [60, 120],
          hourlyPriceVnd: 5_000,
        },
      ],
    });
    expect(stationRepository.findOneBy).toHaveBeenCalledWith({
      id: station.id,
    });
  });

  it("rejects a QR token after the station version rotates", async () => {
    const qrService = new StationQrService(createTokenRepository() as never);
    const stationRepository = {
      findOneBy: vi.fn().mockResolvedValue({
        id: "3d20d6e7-5cbe-4fa2-af18-e8d1ab0ddbe6",
        qrVersion: 2,
      }),
    } as unknown as Repository<Station>;
    const service = new StationScanService(
      stationRepository,
      {} as Repository<Connector>,
      {} as Repository<ManagedDevice>,
      qrService,
      {} as never,
    );
    const { token } = await qrService.issue(
      "3d20d6e7-5cbe-4fa2-af18-e8d1ab0ddbe6",
      1,
    );

    await expect(service.getStationScan(token)).rejects.toThrow(
      NotFoundException,
    );
  });

  it("marks connectors offline when the linked device is in use", async () => {
    const station = {
      id: "3d20d6e7-5cbe-4fa2-af18-e8d1ab0ddbe6",
      code: "ST01",
      name: "Riverside Station",
      deviceId: "core-device-1",
      qrVersion: 2,
    } as Station;
    const connector = {
      id: "connector-1",
      code: "ST01-C01",
      status: ConnectorStatus.AVAILABLE,
      station,
    } as Connector;
    const qrService = new StationQrService(createTokenRepository() as never);
    const service = new StationScanService(
      { findOneBy: vi.fn().mockResolvedValue(station) } as never,
      { find: vi.fn().mockResolvedValue([connector]) } as never,
      {
        findOneBy: vi.fn().mockResolvedValue({
          deviceId: "core-device-1",
          availability: DeviceAvailability.IN_USE,
        }),
      } as never,
      qrService,
      { latestTelemetry: vi.fn().mockResolvedValue({ eventAt: new Date().toISOString() }) } as never,
    );
    const { token } = await qrService.issue(station.id, station.qrVersion);

    await expect(service.getStationScan(token)).resolves.toMatchObject({
      connectors: [expect.objectContaining({ status: ConnectorStatus.OFFLINE })],
    });
  });

  it("marks connectors offline when device telemetry is stale", async () => {
    const station = {
      id: "3d20d6e7-5cbe-4fa2-af18-e8d1ab0ddbe6",
      code: "ST01",
      name: "Riverside Station",
      deviceId: "core-device-1",
      qrVersion: 2,
    } as Station;
    const connector = {
      id: "connector-1",
      code: "ST01-C01",
      status: ConnectorStatus.AVAILABLE,
      station,
    } as Connector;
    const qrService = new StationQrService(createTokenRepository() as never);
    const service = new StationScanService(
      { findOneBy: vi.fn().mockResolvedValue(station) } as never,
      { find: vi.fn().mockResolvedValue([connector]) } as never,
      {
        findOneBy: vi.fn().mockResolvedValue({
          deviceId: "core-device-1",
          availability: DeviceAvailability.AVAILABLE,
        }),
      } as never,
      qrService,
      {
        latestTelemetry: vi.fn().mockResolvedValue({
          eventAt: new Date(Date.now() - 90_001).toISOString(),
        }),
      } as never,
    );
    const { token } = await qrService.issue(station.id, station.qrVersion);

    await expect(service.getStationScan(token)).resolves.toMatchObject({
      connectors: [expect.objectContaining({ status: ConnectorStatus.OFFLINE })],
    });
  });
});

function createTokenRepository() {
  const records = new Map<
    string,
    { stationId: string; qrVersion: number; tokenHash: string }
  >();
  return {
    upsert: vi.fn(
      async (record: {
        stationId: string;
        qrVersion: number;
        tokenHash: string;
      }) => records.set(record.tokenHash, record),
    ),
    findOneBy: vi.fn(async ({ tokenHash }: { tokenHash: string }) => {
      return records.get(tokenHash) ?? null;
    }),
  };
}
