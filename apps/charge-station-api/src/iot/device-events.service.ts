import { randomUUID } from "node:crypto";

import {
  Inject,
  Optional,
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import type {
  DeviceEvent as DeviceEventContract,
  DeviceEventType,
} from "@charge-station/contracts";
import { DataSource, EntityManager } from "typeorm";

import {
  ChargingSession,
  ChargingSessionStatus,
  Connector,
  ConnectorStatus,
  DeviceCommand,
  DeviceCommandStatus,
  DeviceEvent,
} from "../database/data-source.js";
import { ChargeGateway } from "../realtime/charge.gateway.js";

interface DeviceEventPersistenceResult {
  accepted: true;
  duplicate: boolean;
  sessionStatus?: ChargingSessionStatus;
  deviceSnapshot?: Record<string, unknown>;
}

@Injectable()
export class DeviceEventsService {
  private readonly eventQueues = new Map<string, Promise<void>>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional()
    @Inject(ChargeGateway)
    private readonly gateway?: ChargeGateway,
  ) {}

  async handle(
    input: unknown,
  ): Promise<{ accepted: true; duplicate: boolean }> {
    const event = parseDeviceEvent(input);
    const previous = this.eventQueues.get(event.sessionId) ?? Promise.resolve();
    const processing = previous
      .catch(() => undefined)
      .then(() => this.handleSerialized(event));

    const queued = processing.then(
      () => undefined,
      () => undefined,
    );
    this.eventQueues.set(event.sessionId, queued);
    try {
      return await processing;
    } finally {
      if (this.eventQueues.get(event.sessionId) === queued) {
        this.eventQueues.delete(event.sessionId);
      }
    }
  }

  private async handleSerialized(
    event: DeviceEventContract,
  ): Promise<{ accepted: true; duplicate: boolean }> {
    const result =
      await this.dataSource.transaction<DeviceEventPersistenceResult>(
        async (manager) => {
          const sessionId = await lockChargingSessionId(
            manager,
            event.sessionId,
          );
          if (!sessionId) {
            throw new NotFoundException("Charging session not found");
          }

          const sessionRepository = manager.getRepository(ChargingSession);
          const commandRepository = manager.getRepository(DeviceCommand);
          const connectorRepository = manager.getRepository(Connector);
          const eventRepository = manager.getRepository(DeviceEvent);
          const session = await sessionRepository.findOneBy({ id: sessionId });
          if (!session) {
            throw new NotFoundException("Charging session not found");
          }

          const duplicate = await eventRepository.findOneBy({
            eventId: event.eventId,
          });
          if (duplicate) {
            return { accepted: true, duplicate: true };
          }

          const command = await commandRepository.findOne({
            where: { commandId: event.commandId },
            relations: { session: true },
          });
          if (!command || command.session.id !== session.id) {
            throw new BadRequestException(
              "Device event does not match a command",
            );
          }
          if (
            session.connector.code !== event.connectorCode ||
            command.payload.deviceId !== event.deviceId
          ) {
            throw new BadRequestException(
              "Device event does not match its session",
            );
          }

          const occurredAt = new Date(event.occurredAt);
          const storedEvent = eventRepository.create({
            id: randomUUID(),
            eventId: event.eventId,
            session,
            command,
            deviceId: event.deviceId,
            connectorCode: event.connectorCode,
            eventType: event.type,
            occurredAt,
            payload: payloadForPersistence(event, occurredAt),
            processedAt: new Date(),
          });

          let saveSession = false;
          let saveCommand = false;
          let saveConnector = false;
          const isFreshDeviceEvent =
            !session.lastDeviceEventAt ||
            occurredAt.valueOf() > session.lastDeviceEventAt.valueOf();
          if (isFreshDeviceEvent) {
            session.lastDeviceEventAt = occurredAt;
            saveSession = true;
          }
          switch (event.type) {
            case "COMMAND_ACCEPTED":
              if (session.status === ChargingSessionStatus.PENDING) {
                session.status = ChargingSessionStatus.STARTING;
                saveSession = true;
              }
              if (command.status !== DeviceCommandStatus.ACCEPTED) {
                command.status = DeviceCommandStatus.ACCEPTED;
                command.acknowledgedAt = occurredAt;
                saveCommand = true;
              }
              break;
            case "RUNNING":
              if (session.status === ChargingSessionStatus.STARTING) {
                session.status = ChargingSessionStatus.CHARGING;
                session.startedAt = occurredAt;
                saveSession = true;
              }
              break;
            case "HEARTBEAT":
              if (isFreshDeviceEvent) {
                session.estimatedRemainingSeconds = readRemainingSeconds(
                  event.payload,
                );
                session.operationalWarning = null;
                saveSession = true;
              }
              break;
            case "STOPPED":
              if (isNonterminalSessionStatus(session.status)) {
                session.status =
                  event.payload.reason === "TIMER_EXPIRED"
                    ? ChargingSessionStatus.COMPLETED
                    : ChargingSessionStatus.CANCELLED;
                session.stoppedAt = occurredAt;
                saveSession = true;
              }
              if (session.connector.status !== ConnectorStatus.AVAILABLE) {
                session.connector.status = ConnectorStatus.AVAILABLE;
                saveConnector = true;
              }
              break;
            case "COMMAND_FAILED":
              if (
                session.status === ChargingSessionStatus.PENDING ||
                session.status === ChargingSessionStatus.STARTING
              ) {
                session.status = ChargingSessionStatus.START_FAILED;
                saveSession = true;
              }
              if (command.status !== DeviceCommandStatus.FAILED) {
                command.status = DeviceCommandStatus.FAILED;
                saveCommand = true;
              }
              break;
            case "DEVICE_OFFLINE":
              if (isFreshDeviceEvent) {
                session.operationalWarning = "DEVICE_OFFLINE";
                saveSession = true;
              }
              break;
          }

          if (saveSession) {
            await sessionRepository.save(session);
          }
          if (saveCommand) {
            await commandRepository.save(command);
          }
          if (saveConnector) {
            await connectorRepository.save(session.connector);
          }
          await eventRepository.save(storedEvent);
          return {
            accepted: true,
            duplicate: false,
            sessionStatus: session.status,
            deviceSnapshot: {
              type: event.type,
              ...storedEvent.payload,
            },
          };
        },
      );
    if (!result.duplicate && result.sessionStatus && result.deviceSnapshot) {
      this.gateway?.publishSession(
        event.sessionId,
        "session.updated",
        result.sessionStatus,
      );
      this.gateway?.publishSession(
        event.sessionId,
        "device.updated",
        result.deviceSnapshot,
      );
    }
    return { accepted: true, duplicate: result.duplicate };
  }
}

function isNonterminalSessionStatus(status: ChargingSessionStatus): boolean {
  return (
    status !== ChargingSessionStatus.COMPLETED &&
    status !== ChargingSessionStatus.CANCELLED &&
    status !== ChargingSessionStatus.START_FAILED
  );
}

function payloadForPersistence(
  event: DeviceEventContract,
  occurredAt: Date,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ...event.payload,
    lastDeviceEventAt: occurredAt.toISOString(),
  };
  if (event.type === "HEARTBEAT") {
    payload.estimatedRemainingSeconds = readRemainingSeconds(event.payload);
  }
  if (event.type === "RUNNING") {
    payload.relayState = "ON";
  }
  if (event.type === "DEVICE_OFFLINE") {
    payload.operationalWarning = "DEVICE_OFFLINE";
  }
  return payload;
}

function parseDeviceEvent(input: unknown): DeviceEventContract {
  if (!isRecord(input)) {
    throw new BadRequestException("Device event must be an object");
  }
  const type = input.type;
  if (!isDeviceEventType(type)) {
    throw new BadRequestException("Device event type is invalid");
  }
  const occurredAt = readRequiredString(input, "occurredAt");
  if (Number.isNaN(new Date(occurredAt).valueOf())) {
    throw new BadRequestException("Device event occurredAt is invalid");
  }
  const payload = input.payload;
  if (!isRecord(payload)) {
    throw new BadRequestException("Device event payload is invalid");
  }
  if (type === "HEARTBEAT") {
    readRemainingSeconds(payload);
  }

  return {
    eventId: readRequiredString(input, "eventId"),
    commandId: readRequiredString(input, "commandId"),
    sessionId: readRequiredString(input, "sessionId"),
    deviceId: readRequiredString(input, "deviceId"),
    connectorCode: readRequiredString(input, "connectorCode"),
    type,
    occurredAt,
    payload,
  };
}

function isDeviceEventType(value: unknown): value is DeviceEventType {
  return (
    value === "COMMAND_ACCEPTED" ||
    value === "RUNNING" ||
    value === "HEARTBEAT" ||
    value === "STOPPED" ||
    value === "COMMAND_FAILED" ||
    value === "DEVICE_OFFLINE"
  );
}

function readRequiredString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || !value) {
    throw new BadRequestException(`Device event ${key} is required`);
  }
  return value;
}

function readRemainingSeconds(payload: Record<string, unknown>): number {
  const value = payload.remainingSeconds;
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0) {
    throw new BadRequestException(
      "Device heartbeat remainingSeconds must be a non-negative integer",
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
