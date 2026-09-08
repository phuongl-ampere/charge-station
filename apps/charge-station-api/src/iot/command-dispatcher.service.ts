import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnApplicationShutdown,
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
const IOT_READINESS_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;

class DefinitiveStartCommandError extends Error {
  constructor() {
    super("Persisted device command has an expired or invalid start expiry");
  }
}

@Injectable()
export class CommandDispatcherService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(CommandDispatcherService.name);
  private readinessProbeInProgress = false;
  private readinessRecoveryRequested = false;
  private readinessRecoveryDispatched = false;
  private readinessRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly commandsAwaitingIotReadiness = new Set<string>();

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

  onApplicationShutdown(): void {
    if (this.readinessRetryTimer) {
      clearTimeout(this.readinessRetryTimer);
      this.readinessRetryTimer = undefined;
    }
    this.commandsAwaitingIotReadiness.clear();
  }

  dispatchPendingAfterReady(): void {
    if (
      this.readinessRecoveryRequested ||
      this.readinessRecoveryDispatched
    ) {
      return;
    }

    this.readinessRecoveryRequested = true;
    this.ensureIotReadinessProbe();
  }

  dispatchWhenIotReady(commandId: string): void {
    this.commandsAwaitingIotReadiness.add(commandId);
    this.ensureIotReadinessProbe();
  }

  private ensureIotReadinessProbe(): void {
    if (this.readinessProbeInProgress || this.readinessRetryTimer) {
      return;
    }

    this.readinessProbeInProgress = true;
    queueMicrotask(() => {
      void this.probeIotReadiness(0);
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
        if (
          await this.updatePendingCommand(commandRepository, command, {
            status: DeviceCommandStatus.SENT,
            nextAttemptAt: null,
          })
        ) {
          command.status = DeviceCommandStatus.SENT;
          command.nextAttemptAt = null;
        }
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
          const retryCount = command.retryCount + 1;
          const nextAttemptAt = new Date(Date.now() + delayMs);
          if (
            !(
              await this.updatePendingCommand(commandRepository, command, {
                status: DeviceCommandStatus.PENDING,
                retryCount,
                nextAttemptAt,
              })
            )
          ) {
            return;
          }
          command.retryCount = retryCount;
          command.nextAttemptAt = nextAttemptAt;
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
    if (
      await this.updatePendingCommand(commandRepository, command, {
        status: DeviceCommandStatus.FAILED,
        nextAttemptAt: null,
      })
    ) {
      command.status = DeviceCommandStatus.FAILED;
      command.nextAttemptAt = null;
    }
  }

  private async updatePendingCommand(
    commandRepository: Repository<DeviceCommand>,
    command: DeviceCommand,
    values: {
      status: DeviceCommandStatus;
      nextAttemptAt: Date | null;
      retryCount?: number;
    },
  ): Promise<boolean> {
    const result = await commandRepository.update(
      {
        commandId: command.commandId,
        status: DeviceCommandStatus.PENDING,
      },
      values,
    );
    return result.affected === 1;
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

      if (
        !(
          await this.updatePendingCommand(transactionalCommandRepository, command, {
            status: DeviceCommandStatus.FAILED,
            nextAttemptAt: null,
          })
        )
      ) {
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

      if (
        !(
          await this.updatePendingCommand(transactionalCommandRepository, command, {
            status: DeviceCommandStatus.FAILED,
            nextAttemptAt: null,
          })
        )
      ) {
        return null;
      }
      command.status = DeviceCommandStatus.FAILED;
      command.nextAttemptAt = null;

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

  private async probeIotReadiness(attempt: number): Promise<void> {
    let healthy = false;
    try {
      healthy = await this.iotServiceClient.isHealthy();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Unable to probe IoT Service health: ${message}`);
    }

    if (!healthy) {
      this.scheduleIotReadinessProbe(attempt);
      return;
    }

    this.readinessRetryTimer = undefined;
    this.readinessProbeInProgress = false;
    try {
      const recoverPendingCommands = this.readinessRecoveryRequested;
      this.readinessRecoveryRequested = false;
      const commandIds = [...this.commandsAwaitingIotReadiness];
      this.commandsAwaitingIotReadiness.clear();

      if (recoverPendingCommands) {
        this.readinessRecoveryDispatched = true;
        await this.dispatchPending().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(
            "Unable to recover pending IoT commands: " + message,
          );
        });
      }
      for (const commandId of commandIds) {
        await this.dispatch(commandId).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(
            "Unable to dispatch ready IoT command " +
              commandId +
              ": " +
              message,
          );
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Unable to dispatch ready IoT commands: ${message}`);
    } finally {
      if (
        this.readinessRecoveryRequested ||
        this.commandsAwaitingIotReadiness.size > 0
      ) {
        this.ensureIotReadinessProbe();
      }
    }
  }

  private scheduleIotReadinessProbe(attempt: number): void {
    const delayIndex = Math.min(
      attempt,
      IOT_READINESS_RETRY_DELAYS_MS.length - 1,
    );
    this.readinessRetryTimer = setTimeout(() => {
      this.readinessRetryTimer = undefined;
      void this.probeIotReadiness(delayIndex + 1);
    }, IOT_READINESS_RETRY_DELAYS_MS[delayIndex]);
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
