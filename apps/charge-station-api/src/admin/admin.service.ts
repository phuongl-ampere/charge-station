import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { randomUUID } from "node:crypto";
import { DataSource, EntityManager } from "typeorm";

import {
  ChargingSession,
  ChargingSessionStatus,
  Connector,
  ConnectorStatus,
  DeviceCommand,
  DeviceEvent,
  PaymentTransaction,
  PaymentTransactionStatus,
  PricingPlan,
  Station,
} from "../database/data-source.js";
import { StationQrService } from "../stations/station-qr.service.js";

const activeSessionStatuses = new Set<ChargingSessionStatus>([
  ChargingSessionStatus.PENDING,
  ChargingSessionStatus.STARTING,
  ChargingSessionStatus.CHARGING,
  ChargingSessionStatus.STOPPING,
  ChargingSessionStatus.DEVICE_OFFLINE,
]);

const attentionSessionStatuses = new Set<ChargingSessionStatus>([
  ChargingSessionStatus.START_FAILED,
  ChargingSessionStatus.DEVICE_OFFLINE,
]);

export type AdminSessionView = {
  id: string;
  orderId: string;
  status: ChargingSessionStatus;
  stationCode: string;
  stationName: string;
  connectorCode: string;
  amountVnd: number;
  durationMinutes: number;
  requestedAt: string;
  checkInAt: string | null;
  expectedEndAt: string | null;
  checkOutAt: string | null;
  actualDurationSeconds: number | null;
  estimatedRemainingSeconds: number | null;
  lastDeviceEventAt: string | null;
  operationalWarning: string | null;
};

type AdminAlert = {
  category: "CONNECTOR_OFFLINE" | "START_FAILED" | "DEVICE_OFFLINE";
  message: string;
  stationCode: string;
  connectorCode: string;
  sessionId?: string;
};

export interface CreateStationInput {
  code: string;
  deviceId?: string | null;
}

@Injectable()
export class AdminService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly stationQrService: StationQrService,
  ) {}

  async getOverview() {
    const [stations, connectors, sessions, payments] = await Promise.all([
      this.dataSource
        .getRepository(Station)
        .find({ order: { code: "ASC" } }),
      this.dataSource
        .getRepository(Connector)
        .find({ order: { code: "ASC" } }),
      this.dataSource
        .getRepository(ChargingSession)
        .find({ order: { updatedAt: "DESC" } }),
      this.dataSource
        .getRepository(PaymentTransaction)
        .find({ order: { updatedAt: "DESC" } }),
    ]);
    const startOfToday = localDayStart();
    const revenueTodayVnd = payments
      .filter(
        (payment) =>
          payment.status === PaymentTransactionStatus.PAID &&
          payment.updatedAt >= startOfToday,
      )
      .reduce((total, payment) => total + payment.order.amountVnd, 0);

    return {
      stations: stations.length,
      connectors: {
        total: connectors.length,
        available: connectors.filter(
          (connector) => connector.status === ConnectorStatus.AVAILABLE,
        ).length,
        occupied: connectors.filter(
          (connector) => connector.status === ConnectorStatus.OCCUPIED,
        ).length,
        offline: connectors.filter(
          (connector) => connector.status === ConnectorStatus.OFFLINE,
        ).length,
      },
      sessions: {
        active: sessions.filter((session) =>
          activeSessionStatuses.has(session.status),
        ).length,
        charging: sessions.filter(
          (session) => session.status === ChargingSessionStatus.CHARGING,
        ).length,
        attention: sessions.filter((session) =>
          attentionSessionStatuses.has(session.status),
        ).length,
      },
      revenueTodayVnd,
      paymentsPending: payments.filter(
        (payment) => payment.status === PaymentTransactionStatus.PENDING,
      ).length,
      alerts: collectAlerts(connectors, sessions),
    };
  }

  async getStations() {
    const [stations, connectors, sessions] = await Promise.all([
      this.dataSource
        .getRepository(Station)
        .find({ order: { code: "ASC" } }),
      this.dataSource
        .getRepository(Connector)
        .find({ order: { code: "ASC" } }),
      this.dataSource
        .getRepository(ChargingSession)
        .find({ order: { updatedAt: "DESC" } }),
    ]);
    const currentSessionByConnector = new Map<string, ChargingSession>();
    for (const session of sessions) {
      if (
        activeSessionStatuses.has(session.status) &&
        !currentSessionByConnector.has(session.connector.id)
      ) {
        currentSessionByConnector.set(session.connector.id, session);
      }
    }

    return stations.map((station) => ({
      id: station.id,
      code: station.code,
      name: station.name,
      deviceId: station.deviceId,
      connectors: connectors
        .filter((connector) => connector.station.id === station.id)
        .map((connector) => ({
          id: connector.id,
          code: connector.code,
          status: connector.status,
          hourlyPriceVnd: connector.pricingPlan?.hourlyPriceVnd ?? null,
          activeSession: currentSessionByConnector.has(connector.id)
            ? this.toSessionView(currentSessionByConnector.get(connector.id)!)
            : null,
        })),
    }));
  }

  async createStation(input: CreateStationInput) {
    const code = normalizeCode(input.code, "Station code", 60);
    const connectorCode = `${code}-C01`;
    const deviceId = normalizeDeviceId(input.deviceId);

    return this.dataSource.transaction(async (manager) => {
      const stationRepository = manager.getRepository(Station);
      const connectorRepository = manager.getRepository(Connector);
      const pricingRepository = manager.getRepository(PricingPlan);
      if (await stationRepository.findOneBy({ code })) {
        throw new ConflictException("Station code already exists");
      }
      if (await connectorRepository.findOneBy({ code: connectorCode })) {
        throw new ConflictException("Connector code already exists");
      }
      const pricingPlan = (
        await pricingRepository.find({ order: { name: "ASC" }, take: 1 })
      )[0];
      if (!pricingPlan) {
        throw new BadRequestException("No pricing plan is configured");
      }

      const station = await stationRepository.save(
        stationRepository.create({
          id: randomUUID(),
          code,
          name: code,
          deviceId,
          qrVersion: 1,
        }),
      );
      const connector = await connectorRepository.save(
        connectorRepository.create({
          id: randomUUID(),
          code: connectorCode,
          status: ConnectorStatus.AVAILABLE,
          station,
          pricingPlan,
        }),
      );

      return {
        id: station.id,
        code: station.code,
        name: station.name,
        deviceId: station.deviceId,
        qrVersion: station.qrVersion,
        connectors: [
          {
            id: connector.id,
            code: connector.code,
            status: connector.status,
            hourlyPriceVnd: pricingPlan.hourlyPriceVnd,
            activeSession: null,
          },
        ],
      };
    });
  }

  async getStationQr(stationId: string) {
    const station = await this.requireStation(this.dataSource.manager, stationId);
    return this.stationQrView(station);
  }

  async rotateStationQr(stationId: string) {
    return this.dataSource.transaction(async (manager) => {
      const station = await this.requireStation(manager, stationId);
      station.qrVersion += 1;
      const savedStation = await manager.getRepository(Station).save(station);
      return this.stationQrView(savedStation);
    });
  }

  async getSessions(limit = 50): Promise<AdminSessionView[]> {
    const sessions = await this.dataSource.getRepository(ChargingSession).find({
      order: { createdAt: "DESC" },
      take: clampLimit(limit),
    });
    return sessions.map((session) => this.toSessionView(session));
  }

  async getPayments(limit = 50) {
    const payments = await this.dataSource
      .getRepository(PaymentTransaction)
      .find({
        order: { updatedAt: "DESC" },
        take: clampLimit(limit),
      });

    return payments.map((payment) => ({
      id: payment.id,
      provider: payment.provider,
      status: payment.status,
      cancellationStatus: payment.cancellationStatus,
      amountVnd: payment.order.amountVnd,
      currency: payment.order.currency,
      orderId: payment.order.id,
      payosOrderCode: String(payment.order.payosOrderCode),
      connectorCode: payment.order.connector.code,
      checkoutUrl: payment.checkoutUrl,
      expiresAt: payment.expiresAt.toISOString(),
      createdAt: payment.createdAt.toISOString(),
      updatedAt: payment.updatedAt.toISOString(),
    }));
  }

  async getDeviceTimeline(limit = 100) {
    const [commands, events] = await Promise.all([
      this.dataSource.getRepository(DeviceCommand).find({
        order: { createdAt: "DESC" },
        take: clampLimit(limit),
      }),
      this.dataSource.getRepository(DeviceEvent).find({
        order: { occurredAt: "DESC" },
        take: clampLimit(limit),
      }),
    ]);
    const timeline = [
      ...commands.map((command) => ({
        id: command.id,
        kind: "COMMAND" as const,
        type: command.commandType,
        status: command.status,
        at: command.createdAt.toISOString(),
        connectorCode: command.session.connector.code,
        sessionId: command.session.id,
        retryCount: command.retryCount,
        details: command.payload,
      })),
      ...events
        .filter((event) => event.eventType !== "HEARTBEAT")
        .map((event) => ({
          id: event.id,
          kind: "EVENT" as const,
          type: event.eventType,
          status: event.processedAt ? "PROCESSED" : "PENDING",
          at: event.occurredAt.toISOString(),
          connectorCode: event.connectorCode,
          sessionId: event.session?.id ?? null,
          retryCount: null,
          details: event.payload,
        })),
    ];

    return timeline
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, clampLimit(limit));
  }

  private toSessionView(session: ChargingSession): AdminSessionView {
    return {
      id: session.id,
      orderId: session.order.id,
      status: session.status,
      stationCode: session.connector.station.code,
      stationName: session.connector.station.name,
      connectorCode: session.connector.code,
      amountVnd: session.order.amountVnd,
      durationMinutes: session.order.durationMinutes,
      requestedAt: session.order.createdAt.toISOString(),
      checkInAt: toIso(session.startedAt),
      expectedEndAt: toIso(session.expectedEndAt),
      checkOutAt: toIso(session.stoppedAt),
      actualDurationSeconds: actualDurationSeconds(session),
      estimatedRemainingSeconds: session.estimatedRemainingSeconds,
      lastDeviceEventAt: toIso(session.lastDeviceEventAt),
      operationalWarning: session.operationalWarning,
    };
  }

  private async requireStation(
    manager: EntityManager,
    stationId: string,
  ): Promise<Station> {
    const station = await manager.getRepository(Station).findOneBy({
      id: stationId,
    });
    if (!station) {
      throw new NotFoundException("Station not found");
    }
    return station;
  }

  private stationQrView(station: Station) {
    const qr = this.stationQrService.issue(station.id, station.qrVersion);
    return {
      stationId: station.id,
      qrVersion: station.qrVersion,
      scanUrl: qr.url,
    };
  }
}

function collectAlerts(
  connectors: Connector[],
  sessions: ChargingSession[],
): AdminAlert[] {
  const connectorAlerts = connectors
    .filter((connector) => connector.status === ConnectorStatus.OFFLINE)
    .map((connector) => ({
      category: "CONNECTOR_OFFLINE" as const,
      message: "Connector is offline",
      stationCode: connector.station.code,
      connectorCode: connector.code,
    }));
  const sessionAlerts = sessions
    .filter((session) => attentionSessionStatuses.has(session.status))
    .map((session) => ({
      category:
        session.status === ChargingSessionStatus.START_FAILED
          ? ("START_FAILED" as const)
          : ("DEVICE_OFFLINE" as const),
      message:
        session.operationalWarning ??
        (session.status === ChargingSessionStatus.START_FAILED
          ? "Start command failed"
          : "Device is offline"),
      stationCode: session.connector.station.code,
      connectorCode: session.connector.code,
      sessionId: session.id,
    }));

  return [...connectorAlerts, ...sessionAlerts];
}

function localDayStart(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.floor(limit), 1), 100);
}

function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function actualDurationSeconds(session: ChargingSession): number | null {
  if (!session.startedAt || !session.stoppedAt) {
    return null;
  }
  return Math.max(
    0,
    Math.floor((session.stoppedAt.valueOf() - session.startedAt.valueOf()) / 1000),
  );
}

function normalizeCode(
  value: string,
  label: string,
  maximumLength = 64,
): string {
  if (typeof value !== "string") {
    throw new BadRequestException(`${label} is required`);
  }
  const code = value.trim().toUpperCase();
  const pattern = new RegExp(`^[A-Z0-9][A-Z0-9-]{0,${maximumLength - 1}}$`);
  if (!pattern.test(code)) {
    throw new BadRequestException(
      `${label} must use uppercase letters, numbers, and hyphens`,
    );
  }
  return code;
}

function normalizeDeviceId(value: string | null | undefined): string | null {
  if (value === null || value === undefined || !value.trim()) {
    return null;
  }
  if (value.trim().length > 120) {
    throw new BadRequestException("Device ID must be at most 120 characters");
  }
  return value.trim();
}
