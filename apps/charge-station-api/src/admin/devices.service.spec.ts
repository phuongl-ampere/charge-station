import { describe, expect, it, vi } from "vitest";
import type { DataSource } from "typeorm";
import { ServiceUnavailableException } from "@nestjs/common";

import {
  ChargingSession,
  ChargingSessionStatus,
  Station,
} from "../database/data-source.js";
import {
  CoreIotTransportError,
  type CoreIotClient,
} from "../iot/core-iot.client.js";
import { DevicesService } from "./devices.service.js";

describe("DevicesService", () => {
  it("lists one linked device per station with Core relay telemetry and charging state", async () => {
    const station = {
      id: "station-1",
      code: "ST01",
      name: "Riverside",
      deviceId: "core-device-1",
      deviceInUse: false,
    } as Station;
    const activeSession = {
      id: "session-1",
      status: ChargingSessionStatus.CHARGING,
      connector: { station },
    } as ChargingSession;
    const dataSource = {
      getRepository: (entity: unknown) => {
        if (entity === Station) return { find: vi.fn().mockResolvedValue([station]) };
        if (entity === ChargingSession) {
          return { find: vi.fn().mockResolvedValue([activeSession]) };
        }
        throw new Error("Unexpected repository");
      },
    } as unknown as DataSource;
    const core = {
      latestTelemetry: vi.fn().mockResolvedValue({
        eventAt: "2026-09-27T00:00:00.000Z",
        relayState: false,
        sessionId: null,
        remainingSeconds: 0,
        lastStopReason: null,
        voltageV: 230.4,
        currentA: 0,
        powerW: 0,
        energyKwh: 0.1,
        totalPowerW: 2350,
        totalEnergyKwh: 0.2,
        relays: {
          "relay-1": {
            enabled: true,
            remainingSeconds: 60,
            voltageV: 230.4,
            currentA: 10.2,
            powerW: 2350,
            energyKwh: 0.1,
            source: "MANUAL",
          },
        },
      }),
    };
    const service = new DevicesService(
      dataSource,
      core as unknown as CoreIotClient,
    );

    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({
        deviceId: "core-device-1",
        stationCode: "ST01",
        status: "ONLINE",
        inUse: false,
        activeSessionId: "session-1",
        telemetry: expect.objectContaining({ totalPowerW: 2350 }),
      }),
    ]);
  });

  it("marks a device in use while allowing an operator to enable a relay demo", async () => {
    const station = {
      id: "station-1",
      code: "ST01",
      name: "Riverside",
      deviceId: "core-device-1",
      deviceInUse: false,
    } as Station;
    const stationRepository = {
      findOneBy: vi.fn().mockResolvedValue(station),
      save: vi.fn().mockImplementation(async (value) => value),
    };
    const core = { setRelay: vi.fn() };
    const service = new DevicesService(
      {
        getRepository: () => stationRepository,
      } as unknown as DataSource,
      core as unknown as CoreIotClient,
    );

    await expect(service.setInUse("core-device-1", true)).resolves.toEqual({
      deviceId: "core-device-1",
      inUse: true,
    });
    await service.controlRelay("core-device-1", "relay-4", {
      enabled: true,
      durationSeconds: 60,
    });
    expect(core.setRelay).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: "core-device-1",
        relayId: "relay-4",
        enabled: true,
        durationSeconds: 60,
      }),
    );
  });

  it("returns service unavailable when Core cannot acknowledge a relay command", async () => {
    const stationRepository = {
      findOneBy: vi.fn().mockResolvedValue({
        id: "station-1",
        deviceId: "core-device-1",
        deviceInUse: false,
      } as Station),
    };
    const service = new DevicesService(
      { getRepository: () => stationRepository } as unknown as DataSource,
      {
        setRelay: vi
          .fn()
          .mockRejectedValue(new CoreIotTransportError("Core timeout")),
      } as unknown as CoreIotClient,
    );

    await expect(
      service.controlRelay("core-device-1", "relay-1", { enabled: true }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
