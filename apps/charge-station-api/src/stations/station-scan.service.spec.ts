import { NotFoundException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Repository } from "typeorm";

import {
  Connector,
  ConnectorStatus,
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
    const qrService = new StationQrService();
    const service = new StationScanService(
      stationRepository,
      connectorRepository,
      qrService,
    );
    const { token } = qrService.issue(station.id, station.qrVersion);

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
    const qrService = new StationQrService();
    const stationRepository = {
      findOneBy: vi.fn().mockResolvedValue({
        id: "3d20d6e7-5cbe-4fa2-af18-e8d1ab0ddbe6",
        qrVersion: 2,
      }),
    } as unknown as Repository<Station>;
    const service = new StationScanService(
      stationRepository,
      {} as Repository<Connector>,
      qrService,
    );
    const { token } = qrService.issue(
      "3d20d6e7-5cbe-4fa2-af18-e8d1ab0ddbe6",
      1,
    );

    await expect(service.getStationScan(token)).rejects.toThrow(
      NotFoundException,
    );
  });
});
