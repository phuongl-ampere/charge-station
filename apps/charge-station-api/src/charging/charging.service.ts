import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { randomUUID } from "node:crypto";
import { DataSource, EntityManager, In } from "typeorm";

import {
  ChargingSession,
  DeviceCommand,
  DeviceCommandStatus,
  ChargingSessionStatus,
  Connector,
  ConnectorStatus,
} from "../database/data-source.js";
import { CommandDispatcherService } from "../iot/command-dispatcher.service.js";

export interface SessionStatus {
  id: string;
  orderId: string;
  status: string;
  estimatedRemainingSeconds: number | null;
  timerAuthority: "DEVICE";
  lastDeviceEventAt: string | null;
  operationalWarning: string | null;
}

@Injectable()
export class ChargingService {
  private readonly logger = new Logger(ChargingService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional()
    @Inject(CommandDispatcherService)
    private readonly commandDispatcher?: CommandDispatcherService,
  ) {}

  async getSession(id: string): Promise<SessionStatus> {
    const session = await this.dataSource
      .getRepository(ChargingSession)
      .findOneBy({ id });
    if (!session) {
      throw new NotFoundException("Charging session not found");
    }

    return {
      id: session.id,
      orderId: session.order.id,
      status: session.status,
      estimatedRemainingSeconds: session.estimatedRemainingSeconds ?? null,
      timerAuthority: "DEVICE",
      lastDeviceEventAt: session.lastDeviceEventAt?.toISOString() ?? null,
      operationalWarning: session.operationalWarning ?? null,
    };
  }

  async stopSession(id: string): Promise<{ accepted: true }> {
    const commandId = await this.dataSource.transaction(async (manager) => {
      const sessionId = await lockChargingSessionId(manager, id);
      if (!sessionId) {
        throw new NotFoundException("Charging session not found");
      }

      const sessionRepository = manager.getRepository(ChargingSession);
      const commandRepository = manager.getRepository(DeviceCommand);
      const session = await sessionRepository.findOneBy({ id: sessionId });
      if (!session) {
        throw new NotFoundException("Charging session not found");
      }

      if (session.status === ChargingSessionStatus.PENDING) {
        throw new BadRequestException(
          "Charging session cannot be stopped before start dispatch",
        );
      }
      const existingCommand = await commandRepository.findOne({
        where: {
          session: { id: session.id },
          commandType: "STOP_CHARGING",
          status: In([
            DeviceCommandStatus.PENDING,
            DeviceCommandStatus.SENT,
            DeviceCommandStatus.ACCEPTED,
          ]),
        },
      });
      if (existingCommand) {
        return existingCommand.commandId;
      }

      let reason: "USER_REQUESTED" | "SYSTEM_REQUESTED" = "USER_REQUESTED";
      if (session.status === ChargingSessionStatus.STOPPING) {
        const failedCommand = await commandRepository.findOne({
          where: {
            session: { id: session.id },
            commandType: "STOP_CHARGING",
            status: DeviceCommandStatus.FAILED,
          },
          order: { createdAt: "DESC" },
        });
        if (!failedCommand) {
          throw new BadRequestException("Charging session cannot be stopped");
        }
        reason = readStopReason(failedCommand.payload);
      } else if (
        session.status !== ChargingSessionStatus.STARTING &&
        session.status !== ChargingSessionStatus.CHARGING &&
        session.status !== ChargingSessionStatus.DEVICE_OFFLINE
      ) {
        throw new BadRequestException("Charging session cannot be stopped");
      }

      session.status = ChargingSessionStatus.STOPPING;
      await sessionRepository.save(session);

      const deviceId = deviceIdForSession(session);

      const command = commandRepository.create({
        id: randomUUID(),
        commandId: randomUUID(),
        session,
        commandType: "STOP_CHARGING",
        payload: {
          sessionId: session.id,
          connectorCode: session.connector.code,
          deviceId,
          relayId: relayIdFromEnvironment(),
          reason,
        },
        retryCount: 0,
        status: DeviceCommandStatus.PENDING,
        acknowledgedAt: null,
        nextAttemptAt: null,
      });
      const savedCommand = await commandRepository.save(command);
      return savedCommand.commandId;
    });

    this.dispatchStopCommand(commandId);
    return { accepted: true };
  }

  async retryStart(id: string): Promise<{ accepted: true }> {
    const commandId = await this.dataSource.transaction(async (manager) => {
      const sessionId = await lockChargingSessionId(manager, id);
      if (!sessionId) {
        throw new NotFoundException("Charging session not found");
      }

      const sessionRepository = manager.getRepository(ChargingSession);
      const commandRepository = manager.getRepository(DeviceCommand);
      const connectorRepository = manager.getRepository(Connector);
      const session = await sessionRepository.findOneBy({ id: sessionId });
      if (!session) {
        throw new NotFoundException("Charging session not found");
      }
      if (
        session.status !== ChargingSessionStatus.START_FAILED ||
        session.startedAt ||
        session.stoppedAt
      ) {
        throw new BadRequestException(
          "Only a fresh start-failed session can be retried",
        );
      }

      const command = await commandRepository.findOne({
        where: {
          session: { id: session.id },
          commandType: "START_CHARGING",
          status: DeviceCommandStatus.FAILED,
        },
        order: { createdAt: "DESC" },
      });
      if (!command) {
        throw new NotFoundException("Start command not found");
      }
      if (!hasUnexpiredStartPayload(command.payload, session.expectedEndAt)) {
        throw new BadRequestException(
          "The original start command is no longer recoverable",
        );
      }

      const connectorId = await lockConnectorId(manager, session.connector.id);
      const connector = connectorId
        ? await connectorRepository.findOne({ where: { id: connectorId } })
        : null;
      if (!connector || connector.status !== ConnectorStatus.AVAILABLE) {
        throw new BadRequestException("Connector is not available");
      }

      const recoveryCommand = commandRepository.create({
        id: randomUUID(),
        commandId: randomUUID(),
        session,
        commandType: "START_CHARGING",
        payload: { ...command.payload },
        retryCount: 0,
        nextAttemptAt: null,
        status: DeviceCommandStatus.PENDING,
        acknowledgedAt: null,
      });
      session.status = ChargingSessionStatus.PENDING;
      connector.status = ConnectorStatus.OCCUPIED;
      session.connector = connector;

      const savedCommand = await commandRepository.save(recoveryCommand);
      await sessionRepository.save(session);
      await connectorRepository.save(connector);
      return savedCommand.commandId;
    });

    this.dispatchRetryStartCommand(commandId);
    return { accepted: true };
  }

  private dispatchStopCommand(commandId: string): void {
    if (!this.commandDispatcher) {
      this.logger.error(
        `Failed to dispatch stop command ${commandId}: dispatcher unavailable`,
      );
      return;
    }

    this.commandDispatcher.dispatchWhenIotReady(commandId);
  }

  private dispatchRetryStartCommand(commandId: string): void {
    if (!this.commandDispatcher) {
      this.logger.error(
        `Failed to dispatch retry start command ${commandId}: dispatcher unavailable`,
      );
      return;
    }

    this.commandDispatcher.dispatchWhenIotReady(commandId);
  }
}

function hasUnexpiredStartPayload(
  payload: Record<string, unknown>,
  expectedEndAt: Date | null,
): boolean {
  const expiresAt = payload.expiresAt;
  if (typeof expiresAt !== "string" || !expectedEndAt) {
    return false;
  }

  const expiry = new Date(expiresAt);
  return (
    !Number.isNaN(expiry.valueOf()) &&
    expiry.valueOf() > Date.now() &&
    expectedEndAt.valueOf() > Date.now()
  );
}

function readStopReason(
  payload: Record<string, unknown>,
): "USER_REQUESTED" | "SYSTEM_REQUESTED" {
  const reason = payload.reason;
  if (reason !== "USER_REQUESTED" && reason !== "SYSTEM_REQUESTED") {
    throw new BadRequestException("Failed stop command has an invalid reason");
  }
  return reason;
}

function deviceIdForSession(session: ChargingSession): string {
  const mapped = session.connector?.station?.deviceId;
  const configured = process.env.IOT_CORE_DEVICE_ID?.trim();
  if (typeof mapped === "string" && mapped) {
    return mapped;
  }
  if (configured) {
    return configured;
  }
  throw new BadRequestException("Charging session has no Core IoT device mapping");
}

function relayIdFromEnvironment(): string {
  return process.env.IOT_CORE_RELAY_ID?.trim() || "relay-1";
}

async function lockChargingSessionId(
  manager: EntityManager,
  sessionId: string,
): Promise<string | null> {
  const rows = await manager.query(
    "SELECT id FROM charging_sessions WHERE id = $1 FOR UPDATE",
    [sessionId],
  );
  return rows[0]?.id ?? null;
}

async function lockConnectorId(
  manager: EntityManager,
  connectorId: string,
): Promise<string | null> {
  const rows = await manager.query(
    "SELECT id FROM connectors WHERE id = $1 FOR UPDATE",
    [connectorId],
  );
  return rows[0]?.id ?? null;
}
