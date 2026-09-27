import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";

import {
  ChargingSession,
  ChargingSessionStatus,
  Station,
} from "../database/data-source.js";
import type { CoreTelemetry } from "../iot/core-iot.client.js";
import {
  CoreIotClient,
  CoreIotTransportError,
} from "../iot/core-iot.client.js";

const relayIds = new Set(["relay-1", "relay-2", "relay-3", "relay-4"]);
const DEFAULT_MANUAL_DURATION_SECONDS = 15 * 60;

const activeStatuses = new Set<ChargingSessionStatus>([
  ChargingSessionStatus.PENDING,
  ChargingSessionStatus.STARTING,
  ChargingSessionStatus.CHARGING,
  ChargingSessionStatus.STOPPING,
  ChargingSessionStatus.DEVICE_OFFLINE,
]);

export type DeviceListItem = {
  deviceId: string;
  stationId: string;
  stationCode: string;
  stationName: string;
  status: "ONLINE" | "OFFLINE";
  held: boolean;
  activeSessionId: string | null;
  telemetry: CoreTelemetry | null;
  relayIds: ["relay-1", "relay-2", "relay-3", "relay-4"];
};

@Injectable()
export class DevicesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly coreIotClient: CoreIotClient,
  ) {}

  async list(): Promise<DeviceListItem[]> {
    const [stations, sessions] = await Promise.all([
      this.dataSource.getRepository(Station).find({ order: { code: "ASC" } }),
      this.dataSource.getRepository(ChargingSession).find(),
    ]);
    const activeSessionByStationId = new Map<string, ChargingSession>();
    for (const session of sessions) {
      const stationId = session.connector?.station?.id;
      if (stationId && activeStatuses.has(session.status)) {
        activeSessionByStationId.set(stationId, session);
      }
    }

    return Promise.all(
      stations
        .filter((station) => station.deviceId)
        .map(async (station) => {
          const telemetry = await this.readTelemetry(station.deviceId!);
          return {
            deviceId: station.deviceId!,
            stationId: station.id,
            stationCode: station.code,
            stationName: station.name,
            status: telemetry ? "ONLINE" : "OFFLINE",
            held: station.deviceHold,
            activeSessionId: activeSessionByStationId.get(station.id)?.id ?? null,
            telemetry,
            relayIds: ["relay-1", "relay-2", "relay-3", "relay-4"],
          };
        }),
    );
  }

  async get(deviceId: string): Promise<DeviceListItem> {
    const device = (await this.list()).find(
      (candidate) => candidate.deviceId === deviceId,
    );
    if (!device) {
      throw new NotFoundException("Device not found");
    }
    return device;
  }

  async setHold(deviceId: string, held: boolean): Promise<{ deviceId: string; held: boolean }> {
    const station = await this.requireStation(deviceId);
    station.deviceHold = held;
    await this.dataSource.getRepository(Station).save(station);
    return { deviceId, held };
  }

  async controlRelay(
    deviceId: string,
    relayId: string,
    input: { enabled: boolean; durationSeconds?: number },
  ) {
    if (!relayIds.has(relayId)) {
      throw new BadRequestException("Unknown relay");
    }
    const station = await this.requireStation(deviceId);
    if (station.deviceHold && input.enabled) {
      throw new BadRequestException("Device is held");
    }
    const durationSeconds = input.enabled
      ? input.durationSeconds ?? DEFAULT_MANUAL_DURATION_SECONDS
      : undefined;
    if (
      durationSeconds !== undefined &&
      (!Number.isInteger(durationSeconds) || durationSeconds <= 0)
    ) {
      throw new BadRequestException("Relay duration must be a positive integer");
    }
    try {
      return await this.coreIotClient.setRelay({
        commandId: randomUUID(),
        deviceId,
        relayId,
        enabled: input.enabled,
        ...(durationSeconds === undefined ? {} : { durationSeconds }),
      });
    } catch (error) {
      if (error instanceof CoreIotTransportError) {
        throw new ServiceUnavailableException("Core IoT relay control unavailable");
      }
      throw error;
    }
  }

  private async requireStation(deviceId: string): Promise<Station> {
    const station = await this.dataSource
      .getRepository(Station)
      .findOneBy({ deviceId });
    if (!station) {
      throw new NotFoundException("Device not found");
    }
    return station;
  }

  private async readTelemetry(deviceId: string): Promise<CoreTelemetry | null> {
    try {
      return await this.coreIotClient.latestTelemetry(deviceId);
    } catch {
      return null;
    }
  }
}
