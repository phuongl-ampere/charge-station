import { Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, In } from "typeorm";

import {
  ChargingSession,
  ChargingSessionStatus,
  DeviceCommand,
} from "../database/data-source.js";
import { CoreIotClient, type CoreTelemetry } from "./core-iot.client.js";
import { DeviceEventsService } from "./device-events.service.js";

const DEFAULT_TELEMETRY_STALE_MS = 90_000;
const DEFAULT_TELEMETRY_POLL_MS = 15_000;
const MAX_TELEMETRY_STALE_MS = 15 * 60_000;
const MAX_TELEMETRY_POLL_MS = 60_000;

interface ActiveStartCommand {
  commandId: string;
  sessionId: string;
  deviceId: string;
  connectorCode: string;
  lastDeviceEventAt: Date | null;
  operationalWarning: string | null;
}

@Injectable()
export class CoreTelemetryMonitor implements OnApplicationShutdown {
  private readonly logger = new Logger(CoreTelemetryMonitor.name);
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly coreIotClient: CoreIotClient,
    private readonly events: DeviceEventsService,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, telemetryPollMs());
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  onApplicationShutdown(): void {
    this.stop();
  }

  async pollOnce(): Promise<void> {
    for (const start of await this.activeStartCommands()) {
      let sample: CoreTelemetry | null;
      try {
        sample = await this.coreIotClient.latestTelemetry(start.deviceId);
      } catch (error: unknown) {
        this.logger.warn(
          `Unable to read Core telemetry for ${start.deviceId}: ${errorMessage(error)}`,
        );
        continue;
      }

      if (!sample || isStale(sample, Date.now())) {
        await this.emitOfflineIfNeeded(start);
        continue;
      }
      if (!isNewerThan(sample.eventAt, start.lastDeviceEventAt)) {
        continue;
      }
      if (sample.sessionId !== start.sessionId) {
        continue;
      }

      if (sample.relayState && isRemainingSeconds(sample.remainingSeconds)) {
        await this.events.handle({
          eventId: eventId(start, sample, "HEARTBEAT"),
          commandId: start.commandId,
          sessionId: start.sessionId,
          deviceId: start.deviceId,
          connectorCode: start.connectorCode,
          type: "HEARTBEAT",
          occurredAt: sample.eventAt,
          payload: { remainingSeconds: sample.remainingSeconds },
        });
      } else if (sample.lastStopReason === "TIMER_EXPIRED") {
        await this.events.handle({
          eventId: eventId(start, sample, "STOPPED"),
          commandId: start.commandId,
          sessionId: start.sessionId,
          deviceId: start.deviceId,
          connectorCode: start.connectorCode,
          type: "STOPPED",
          occurredAt: sample.eventAt,
          payload: { reason: "TIMER_EXPIRED", relayState: "OFF" },
        });
      }
    }
  }

  private async poll(): Promise<void> {
    try {
      await this.pollOnce();
    } catch (error: unknown) {
      this.logger.error(
        `Unable to poll Core telemetry: ${errorMessage(error)}`,
      );
    }
  }

  private async emitOfflineIfNeeded(start: ActiveStartCommand): Promise<void> {
    if (start.operationalWarning === "DEVICE_OFFLINE") {
      return;
    }
    await this.events.handle({
      eventId: `core:${start.commandId}:DEVICE_OFFLINE:${start.lastDeviceEventAt?.toISOString() ?? "none"}`,
      commandId: start.commandId,
      sessionId: start.sessionId,
      deviceId: start.deviceId,
      connectorCode: start.connectorCode,
      type: "DEVICE_OFFLINE",
      occurredAt: new Date().toISOString(),
      payload: { reason: "STALE_TELEMETRY" },
    });
  }

  private async activeStartCommands(): Promise<ActiveStartCommand[]> {
    const sessions = await this.dataSource.getRepository(ChargingSession).find({
      where: {
        status: In([
          ChargingSessionStatus.STARTING,
          ChargingSessionStatus.CHARGING,
          ChargingSessionStatus.STOPPING,
          ChargingSessionStatus.DEVICE_OFFLINE,
        ]),
      },
      relations: { connector: { station: true } },
    });
    const commandRepository = this.dataSource.getRepository(DeviceCommand);
    const starts = await Promise.all(
      sessions.map(async (session) => {
        const command = await commandRepository.findOne({
          where: {
            session: { id: session.id },
            commandType: "START_CHARGING",
          },
          order: { createdAt: "ASC" },
        });
        const deviceId = command && readString(command.payload, "deviceId");
        if (!command || !deviceId || !session.connector?.code) {
          return null;
        }
        return {
          commandId: command.commandId,
          sessionId: session.id,
          deviceId,
          connectorCode: session.connector.code,
          lastDeviceEventAt: session.lastDeviceEventAt,
          operationalWarning: session.operationalWarning,
        };
      }),
    );
    return starts.filter(
      (start): start is ActiveStartCommand => start !== null,
    );
  }
}

function isStale(sample: CoreTelemetry, now: number): boolean {
  const eventAt = Date.parse(sample.eventAt);
  return Number.isNaN(eventAt) || eventAt <= now - telemetryStaleMs();
}

function isNewerThan(eventAt: string, lastDeviceEventAt: Date | null): boolean {
  const timestamp = Date.parse(eventAt);
  return (
    !Number.isNaN(timestamp) &&
    (!lastDeviceEventAt || timestamp > lastDeviceEventAt.valueOf())
  );
}

function isRemainingSeconds(value: number | null): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function eventId(
  start: ActiveStartCommand,
  sample: CoreTelemetry,
  type: "HEARTBEAT" | "STOPPED",
): string {
  return `core:${start.commandId}:${type}:${sample.eventAt}`;
}

function readString(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const candidate = value[key];
  return typeof candidate === "string" && candidate ? candidate : null;
}

function telemetryStaleMs(): number {
  return envMilliseconds(
    "IOT_CORE_TELEMETRY_STALE_MS",
    DEFAULT_TELEMETRY_STALE_MS,
    MAX_TELEMETRY_STALE_MS,
  );
}

function telemetryPollMs(): number {
  return envMilliseconds(
    "IOT_CORE_TELEMETRY_POLL_MS",
    DEFAULT_TELEMETRY_POLL_MS,
    MAX_TELEMETRY_POLL_MS,
  );
}

function envMilliseconds(
  name: string,
  fallback: number,
  maximum: number,
): number {
  const configured = Number(process.env[name]);
  if (!Number.isFinite(configured) || configured <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(configured), maximum);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
