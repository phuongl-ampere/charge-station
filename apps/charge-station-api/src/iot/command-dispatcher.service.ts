import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  Optional,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import type {
  StartChargingCommand,
  StopChargingCommand,
} from "@charge-station/contracts";
import { DataSource, EntityManager, Repository } from "typeorm";

import {
  ChargingSession,
  ChargingSessionStatus,
  Connector,
  ConnectorStatus,
  DeviceCommand,
  DeviceCommandStatus,
} from "../database/data-source.js";
import { ChargeGateway } from "../realtime/charge.gateway.js";
import {
  IotCommandRejectedError,
  IotServiceClient,
  IotTransportError,
} from "./iot-service.client.js";

const RETRY_DELAYS_MS = [1_000, 5_000, 20_000] as const;

class DefinitiveStartCommandError extends Error {
  constructor() {
    super("Persisted device command has an expired or invalid start expiry");
  }
}

@Injectable()
export class CommandDispatcherService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CommandDispatcherService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly iotServiceClient: IotServiceClient,
    @Optional()
    @Inject(ChargeGateway)
    private readonly gateway?: ChargeGateway,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Pending command recovery begins only after the HTTP listener is ready.
  }

  dispatchPendingAfterReady(): void {
    queueMicrotask(() => {
      void this.dispatchPending().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Unable to dispatch pending IoT commands: ${message}`,
        );
      });
    });
  }

  async dispatch(commandId: string): Promise<void> {
    const commandRepository = this.dataSource.getRepository(DeviceCommand);
    const command = await commandRepository.findOne({
      where: { commandId },
      relations: { session: { connector: { station: true }, order: true } },
    });
    if (!command) {
      throw new NotFoundException("Device command not found");
    }
    if (command.status !== DeviceCommandStatus.PENDING) {
      return;
    }

    let commandPayload: StartChargingCommand | StopChargingCommand;
    try {
      commandPayload = toDeviceCommand(command);
    } catch (error: unknown) {
      await this.markPreDispatchFailure(command, commandRepository, error);
      throw error;
    }

    while (true) {
      try {
        await this.waitForScheduledAttempt(command);
        if ("durationSeconds" in commandPayload) {
          assertStartCommandExpiry(commandPayload.expiresAt);
        }
      } catch (error: unknown) {
        await this.markPreDispatchFailure(command, commandRepository, error);
        throw error;
      }
      try {
        await this.send(commandPayload);
        command.status = DeviceCommandStatus.SENT;
        command.nextAttemptAt = null;
        await commandRepository.save(command);
        return;
      } catch (error: unknown) {
        if (error instanceof IotTransportError) {
          if (
            !Number.isInteger(command.retryCount) ||
            command.retryCount < 0 ||
            command.retryCount >= RETRY_DELAYS_MS.length
          ) {
            await this.markRetryExhausted(command, commandRepository);
            throw error;
          }

          const delayMs = RETRY_DELAYS_MS[command.retryCount];
          command.retryCount += 1;
          command.nextAttemptAt = new Date(Date.now() + delayMs);
          await commandRepository.save(command);
          await this.wait(delayMs);
          continue;
        }

        if (
          error instanceof IotCommandRejectedError &&
          command.commandType === "START_CHARGING"
        ) {
          await this.markDefinitiveStartFailure(command, commandRepository);
        } else {
          await this.markFailed(command, commandRepository);
        }
        throw error;
      }
    }
  }

  private async send(
    command: StartChargingCommand | StopChargingCommand,
  ): Promise<void> {
    if ("durationSeconds" in command) {
      await this.iotServiceClient.start(command);
      return;
    }
    await this.iotServiceClient.stop(command);
  }

  protected wait(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  private async waitForScheduledAttempt(command: DeviceCommand): Promise<void> {
    if (!command.nextAttemptAt) {
      return;
    }

    const scheduledAt = command.nextAttemptAt.valueOf();
    if (Number.isNaN(scheduledAt)) {
      throw new Error("Persisted device command has an invalid retry schedule");
    }

    const delayMs = scheduledAt - Date.now();
    if (delayMs > 0) {
      await this.wait(delayMs);
    }
  }

  private async markFailed(
    command: DeviceCommand,
    commandRepository: Repository<DeviceCommand>,
  ): Promise<void> {
    command.status = DeviceCommandStatus.FAILED;
    command.nextAttemptAt = null;
    await commandRepository.save(command);
  }

  private async markPreDispatchFailure(
    command: DeviceCommand,
    commandRepository: Repository<DeviceCommand>,
    error: unknown,
  ): Promise<void> {
    if (
      command.commandType === "START_CHARGING" &&
      error instanceof DefinitiveStartCommandError
    ) {
      await this.markDefinitiveStartFailure(command, commandRepository);
      return;
    }

    await this.markFailed(command, commandRepository);
  }

  private async markRetryExhausted(
    command: DeviceCommand,
    commandRepository: Repository<DeviceCommand>,
  ): Promise<void> {
    if (command.commandType !== "START_CHARGING") {
      await this.markFailed(command, commandRepository);
      return;
    }

    const result = await this.dataSource.transaction(async (manager) => {
      const transactionalCommandRepository =
        manager.getRepository(DeviceCommand);
      const sessionId = await lockChargingSessionId(
        manager,
        command.session.id,
      );
      if (!sessionId) {
        await this.markFailed(command, transactionalCommandRepository);
        return null;
      }

      const sessionRepository = manager.getRepository(ChargingSession);
      const session = await sessionRepository.findOneBy({ id: sessionId });
      if (!session) {
        await this.markFailed(command, transactionalCommandRepository);
        return null;
      }

      command.status = DeviceCommandStatus.FAILED;
      command.nextAttemptAt = null;
      const shouldMarkStateUnknown =
        session.status === ChargingSessionStatus.PENDING ||
        session.status === ChargingSessionStatus.STARTING;
      if (shouldMarkStateUnknown) {
        session.status = ChargingSessionStatus.DEVICE_OFFLINE;
        session.operationalWarning = "START_STATE_UNKNOWN";
      }

      await transactionalCommandRepository.save(command);
      if (shouldMarkStateUnknown) {
        await sessionRepository.save(session);
      }

      return shouldMarkStateUnknown
        ? { sessionId: session.id, status: session.status }
        : null;
    });

    if (result) {
      this.gateway?.publishSession(
        result.sessionId,
        "session.updated",
        result.status,
      );
    }
  }

  private async markDefinitiveStartFailure(
    command: DeviceCommand,
    commandRepository: Repository<DeviceCommand>,
  ): Promise<void> {
    const result = await this.dataSource.transaction(async (manager) => {
      const transactionalCommandRepository =
        manager.getRepository(DeviceCommand);
      const sessionId = await lockChargingSessionId(
        manager,
        command.session.id,
      );
      if (!sessionId) {
        await this.markFailed(command, transactionalCommandRepository);
        return null;
      }

      const sessionRepository = manager.getRepository(ChargingSession);
      const connectorRepository = manager.getRepository(Connector);
      const session = await sessionRepository.findOneBy({ id: sessionId });
      if (!session) {
        await this.markFailed(command, transactionalCommandRepository);
        return null;
      }

      command.status = DeviceCommandStatus.FAILED;
      command.nextAttemptAt = null;
      await transactionalCommandRepository.save(command);

      if (
        session.status !== ChargingSessionStatus.PENDING &&
        session.status !== ChargingSessionStatus.STARTING
      ) {
        return null;
      }

      const connectorId = await lockConnectorId(manager, session.connector.id);
      const connector = connectorId
        ? await connectorRepository.findOne({ where: { id: connectorId } })
        : null;
      session.status = ChargingSessionStatus.START_FAILED;
      session.operationalWarning = null;
      if (connector) {
        connector.status = ConnectorStatus.AVAILABLE;
        session.connector = connector;
      }

      await sessionRepository.save(session);
      if (connector) {
        await connectorRepository.save(connector);
      }
      return { sessionId: session.id, status: session.status };
    });

    if (result) {
      this.gateway?.publishSession(
        result.sessionId,
        "session.updated",
        result.status,
      );
    }
  }

  private async dispatchPending(): Promise<void> {
    const commandRepository = this.dataSource.getRepository(DeviceCommand);
    const commands = await commandRepository.find({
      where: { status: DeviceCommandStatus.PENDING },
    });

    for (const command of commands) {
      try {
        await this.dispatch(command.commandId);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Unable to dispatch IoT command ${command.commandId}: ${message}`,
        );
      }
    }
  }
}

function toDeviceCommand(
  command: DeviceCommand,
): StartChargingCommand | StopChargingCommand {
  if (command.commandType === "START_CHARGING") {
    return toStartChargingCommand(command);
  }
  if (command.commandType === "STOP_CHARGING") {
    return toStopChargingCommand(command);
  }
  throw new Error("Persisted device command has an invalid command type");
}

function toStartChargingCommand(command: DeviceCommand): StartChargingCommand {
  const payload = command.payload;
  const sessionId = readString(payload, "sessionId");
  const stationCode = readString(payload, "stationCode");
  const connectorCode = readString(payload, "connectorCode");
  const expiresAt = readString(payload, "expiresAt");
  const durationSeconds = payload.durationSeconds;
  const configVersion = payload.configVersion;

  if (
    !isPositiveInteger(durationSeconds) ||
    !isPositiveInteger(configVersion)
  ) {
    throw new Error("Persisted device command has an invalid start payload");
  }
  assertStartCommandExpiry(expiresAt);

  return {
    commandId: command.commandId,
    sessionId,
    stationCode,
    connectorCode,
    durationSeconds,
    expiresAt,
    configVersion,
  };
}

function toStopChargingCommand(command: DeviceCommand): StopChargingCommand {
  const sessionId = readString(command.payload, "sessionId", "stop");
  const reason = command.payload.reason;
  if (reason !== "USER_REQUESTED" && reason !== "SYSTEM_REQUESTED") {
    throw new Error("Persisted device command has an invalid stop payload");
  }

  return {
    commandId: command.commandId,
    sessionId,
    reason,
  };
}

function readString(
  payload: Record<string, unknown>,
  key: string,
  commandType: "start" | "stop" = "start",
): string {
  const value = payload[key];
  if (typeof value !== "string" || !value) {
    throw new Error(
      `Persisted device command has an invalid ${commandType} payload`,
    );
  }
  return value;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value > 0;
}

function assertStartCommandExpiry(expiresAt: string): void {
  const expiry = new Date(expiresAt);
  if (
    Number.isNaN(expiry.valueOf()) ||
    expiry.toISOString() !== expiresAt ||
    expiry.valueOf() <= Date.now()
  ) {
    throw new DefinitiveStartCommandError();
  }
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
