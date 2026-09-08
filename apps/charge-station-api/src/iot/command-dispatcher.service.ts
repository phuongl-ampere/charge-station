import { randomUUID } from "node:crypto";

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
const DISPATCH_CLAIM_LEASE_MS = 30_000;

interface DispatchClaim {
  token: string;
  version: number;
  claimedAt: Date;
}

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
  private readonly claimRecoveryTimers = new Map<
    string,
    { token: string; timer: ReturnType<typeof setTimeout> }
  >();

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
    for (const { timer } of this.claimRecoveryTimers.values()) {
      clearTimeout(timer);
    }
    this.claimRecoveryTimers.clear();
    this.commandsAwaitingIotReadiness.clear();
  }

  dispatchPendingAfterReady(): void {
    if (this.readinessRecoveryRequested || this.readinessRecoveryDispatched) {
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
    const scheduledCommand = await commandRepository.findOne({
      where: { commandId },
      relations: { session: { connector: { station: true }, order: true } },
    });
    if (!scheduledCommand) {
      throw new NotFoundException("Device command not found");
    }
    if (scheduledCommand.status === DeviceCommandStatus.DISPATCHING) {
      if (
        !(await this.recoverStaleClaim(commandRepository, scheduledCommand))
      ) {
        return;
      }
      await this.dispatch(commandId);
      return;
    }
    if (scheduledCommand.status !== DeviceCommandStatus.PENDING) {
      return;
    }

    try {
      await this.waitForScheduledAttempt(scheduledCommand);
    } catch (error: unknown) {
      const failureClaim = await this.claimPendingCommand(
        commandRepository,
        scheduledCommand,
      );
      if (failureClaim) {
        const claimedCommand = await this.findClaimedCommand(
          commandRepository,
          commandId,
          failureClaim.token,
        );
        if (claimedCommand) {
          this.scheduleClaimRecovery(claimedCommand.commandId, failureClaim);
          await this.markPreDispatchFailure(
            claimedCommand,
            commandRepository,
            failureClaim,
            error,
          );
          this.clearClaimRecovery(commandId, failureClaim.token);
        }
      }
      throw error;
    }

    let claim: DispatchClaim | null = null;
    let claimedCommand: DeviceCommand | null = null;
    let commandPayload: StartChargingCommand | StopChargingCommand | undefined;
    try {
      claim = await this.claimPendingCommand(
        commandRepository,
        scheduledCommand,
      );
      if (!claim) {
        return;
      }
      claimedCommand = await this.findClaimedCommand(
        commandRepository,
        commandId,
        claim.token,
      );
      if (!claimedCommand) {
        return;
      }
      this.scheduleClaimRecovery(claimedCommand.commandId, claim);
      commandPayload = toDeviceCommand(claimedCommand);
    } catch (error: unknown) {
      if (claim) {
        const claimedCommand = await this.findClaimedCommand(
          commandRepository,
          commandId,
          claim.token,
        );
        if (claimedCommand) {
          await this.markPreDispatchFailure(
            claimedCommand,
            commandRepository,
            claim,
            error,
          );
        }
        this.clearClaimRecovery(commandId, claim.token);
      }
      throw error;
    }

    if (!claim || !claimedCommand || !commandPayload) {
      return;
    }
    await this.dispatchClaimedCommand(
      claimedCommand,
      commandRepository,
      claim,
      commandPayload,
    );
  }

  private async dispatchClaimedCommand(
    command: DeviceCommand,
    commandRepository: Repository<DeviceCommand>,
    claim: DispatchClaim,
    commandPayload: StartChargingCommand | StopChargingCommand,
  ): Promise<void> {
    try {
      if ("durationSeconds" in commandPayload) {
        assertStartCommandExpiry(commandPayload.expiresAt);
      }
      await this.send(commandPayload);
      if (
        await this.updateClaimedCommand(commandRepository, command, claim, {
          status: DeviceCommandStatus.SENT,
          nextAttemptAt: null,
        })
      ) {
        command.status = DeviceCommandStatus.SENT;
        command.nextAttemptAt = null;
        command.dispatchClaimToken = null;
        command.dispatchClaimedAt = null;
        command.dispatchVersion = claim.version + 1;
      }
      this.clearClaimRecovery(command.commandId, claim.token);
      return;
    } catch (error: unknown) {
      if (error instanceof IotTransportError) {
        if (
          !Number.isInteger(command.retryCount) ||
          command.retryCount < 0 ||
          command.retryCount >= RETRY_DELAYS_MS.length
        ) {
          await this.markRetryExhausted(command, commandRepository, claim);
          this.clearClaimRecovery(command.commandId, claim.token);
          throw error;
        }

        const delayMs = RETRY_DELAYS_MS[command.retryCount];
        const retryCount = command.retryCount + 1;
        const nextAttemptAt = new Date(Date.now() + delayMs);
        if (
          !(await this.updateClaimedCommand(commandRepository, command, claim, {
            status: DeviceCommandStatus.PENDING,
            retryCount,
            nextAttemptAt,
          }))
        ) {
          this.clearClaimRecovery(command.commandId, claim.token);
          return;
        }
        command.status = DeviceCommandStatus.PENDING;
        command.retryCount = retryCount;
        command.nextAttemptAt = nextAttemptAt;
        command.dispatchClaimToken = null;
        command.dispatchClaimedAt = null;
        command.dispatchVersion = claim.version + 1;
        this.clearClaimRecovery(command.commandId, claim.token);
        await this.wait(delayMs);
        await this.dispatch(command.commandId);
        return;
      }

      if (
        error instanceof IotCommandRejectedError &&
        command.commandType === "START_CHARGING"
      ) {
        await this.markDefinitiveStartFailure(
          command,
          commandRepository,
          claim,
        );
      } else {
        await this.markFailed(command, commandRepository, claim);
      }
      this.clearClaimRecovery(command.commandId, claim.token);
      throw error;
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

  private async claimPendingCommand(
    commandRepository: Repository<DeviceCommand>,
    command: DeviceCommand,
  ): Promise<DispatchClaim | null> {
    const token = randomUUID();
    const claimedAt = new Date();
    const baseVersion = normalizedDispatchVersion(command.dispatchVersion);
    const result = await commandRepository.update(
      {
        commandId: command.commandId,
        status: DeviceCommandStatus.PENDING,
        dispatchVersion: baseVersion,
      },
      {
        status: DeviceCommandStatus.DISPATCHING,
        dispatchClaimToken: token,
        dispatchClaimedAt: claimedAt,
        dispatchVersion: incrementDispatchVersion(),
      } as never,
    );
    return result.affected === 1
      ? { token, version: baseVersion + 1, claimedAt }
      : null;
  }

  private async findClaimedCommand(
    commandRepository: Repository<DeviceCommand>,
    commandId: string,
    token: string,
  ): Promise<DeviceCommand | null> {
    return commandRepository.findOne({
      where: {
        commandId,
        status: DeviceCommandStatus.DISPATCHING,
        dispatchClaimToken: token,
      },
      relations: { session: { connector: { station: true }, order: true } },
    });
  }

  private async recoverStaleClaim(
    commandRepository: Repository<DeviceCommand>,
    command: DeviceCommand,
  ): Promise<boolean> {
    const claimedAt = command.dispatchClaimedAt?.valueOf();
    if (
      claimedAt !== undefined &&
      !Number.isNaN(claimedAt) &&
      claimedAt > Date.now() - DISPATCH_CLAIM_LEASE_MS
    ) {
      return false;
    }

    const baseVersion = normalizedDispatchVersion(command.dispatchVersion);
    const criteria: Record<string, unknown> = {
      commandId: command.commandId,
      status: DeviceCommandStatus.DISPATCHING,
      dispatchVersion: baseVersion,
    };
    if (command.dispatchClaimToken) {
      criteria.dispatchClaimToken = command.dispatchClaimToken;
    }
    const result = await commandRepository.update(criteria, {
      status: DeviceCommandStatus.PENDING,
      dispatchClaimToken: null,
      dispatchClaimedAt: null,
      dispatchVersion: incrementDispatchVersion(),
    } as never);
    if (result.affected === 1) {
      this.clearClaimRecovery(
        command.commandId,
        command.dispatchClaimToken ?? undefined,
      );
      return true;
    }
    return false;
  }

  private scheduleClaimRecovery(commandId: string, claim: DispatchClaim): void {
    this.clearClaimRecovery(commandId);
    const delayMs = Math.max(
      0,
      claim.claimedAt.valueOf() + DISPATCH_CLAIM_LEASE_MS - Date.now(),
    );
    const timer = setTimeout(() => {
      const scheduled = this.claimRecoveryTimers.get(commandId);
      if (!scheduled || scheduled.token !== claim.token) {
        return;
      }
      this.claimRecoveryTimers.delete(commandId);
      void this.dispatch(commandId).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          "Unable to recover stale IoT command claim " +
            commandId +
            ": " +
            message,
        );
      });
    }, delayMs);
    this.claimRecoveryTimers.set(commandId, { token: claim.token, timer });
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  private clearClaimRecovery(commandId: string, token?: string): void {
    const scheduled = this.claimRecoveryTimers.get(commandId);
    if (!scheduled || (token && scheduled.token !== token)) {
      return;
    }
    clearTimeout(scheduled.timer);
    this.claimRecoveryTimers.delete(commandId);
  }

  private async markFailed(
    command: DeviceCommand,
    commandRepository: Repository<DeviceCommand>,
    claim: DispatchClaim,
  ): Promise<void> {
    if (
      await this.updateClaimedCommand(commandRepository, command, claim, {
        status: DeviceCommandStatus.FAILED,
        nextAttemptAt: null,
      })
    ) {
      command.status = DeviceCommandStatus.FAILED;
      command.nextAttemptAt = null;
      command.dispatchClaimToken = null;
      command.dispatchClaimedAt = null;
      command.dispatchVersion = claim.version + 1;
    }
  }

  private async updateClaimedCommand(
    commandRepository: Repository<DeviceCommand>,
    command: DeviceCommand,
    claim: DispatchClaim,
    values: {
      status: DeviceCommandStatus;
      nextAttemptAt: Date | null;
      retryCount?: number;
    },
  ): Promise<boolean> {
    const result = await commandRepository.update(
      {
        commandId: command.commandId,
        status: DeviceCommandStatus.DISPATCHING,
        dispatchClaimToken: claim.token,
        dispatchVersion: claim.version,
      },
      {
        ...values,
        dispatchClaimToken: null,
        dispatchClaimedAt: null,
        dispatchVersion: incrementDispatchVersion(),
      } as never,
    );
    return result.affected === 1;
  }

  private async markPreDispatchFailure(
    command: DeviceCommand,
    commandRepository: Repository<DeviceCommand>,
    claim: DispatchClaim,
    error: unknown,
  ): Promise<void> {
    if (
      command.commandType === "START_CHARGING" &&
      error instanceof DefinitiveStartCommandError
    ) {
      await this.markDefinitiveStartFailure(command, commandRepository, claim);
      return;
    }

    await this.markFailed(command, commandRepository, claim);
  }

  private async markRetryExhausted(
    command: DeviceCommand,
    commandRepository: Repository<DeviceCommand>,
    claim: DispatchClaim,
  ): Promise<void> {
    if (command.commandType !== "START_CHARGING") {
      await this.markFailed(command, commandRepository, claim);
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
        await this.markFailed(command, transactionalCommandRepository, claim);
        return null;
      }

      const sessionRepository = manager.getRepository(ChargingSession);
      const session = await sessionRepository.findOneBy({ id: sessionId });
      if (!session) {
        await this.markFailed(command, transactionalCommandRepository, claim);
        return null;
      }

      if (
        !(await this.updateClaimedCommand(
          transactionalCommandRepository,
          command,
          claim,
          {
            status: DeviceCommandStatus.FAILED,
            nextAttemptAt: null,
          },
        ))
      ) {
        return null;
      }
      command.status = DeviceCommandStatus.FAILED;
      command.nextAttemptAt = null;
      command.dispatchClaimToken = null;
      command.dispatchClaimedAt = null;
      command.dispatchVersion = claim.version + 1;
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
    claim: DispatchClaim,
  ): Promise<void> {
    const result = await this.dataSource.transaction(async (manager) => {
      const transactionalCommandRepository =
        manager.getRepository(DeviceCommand);
      const sessionId = await lockChargingSessionId(
        manager,
        command.session.id,
      );
      if (!sessionId) {
        await this.markFailed(command, transactionalCommandRepository, claim);
        return null;
      }

      const sessionRepository = manager.getRepository(ChargingSession);
      const connectorRepository = manager.getRepository(Connector);
      const session = await sessionRepository.findOneBy({ id: sessionId });
      if (!session) {
        await this.markFailed(command, transactionalCommandRepository, claim);
        return null;
      }

      if (
        !(await this.updateClaimedCommand(
          transactionalCommandRepository,
          command,
          claim,
          {
            status: DeviceCommandStatus.FAILED,
            nextAttemptAt: null,
          },
        ))
      ) {
        return null;
      }
      command.status = DeviceCommandStatus.FAILED;
      command.nextAttemptAt = null;
      command.dispatchClaimToken = null;
      command.dispatchClaimedAt = null;
      command.dispatchVersion = claim.version + 1;

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
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.error(
            "Unable to recover pending IoT commands: " + message,
          );
        });
      }
      for (const commandId of commandIds) {
        await this.dispatch(commandId).catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
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
      where: [
        { status: DeviceCommandStatus.PENDING },
        { status: DeviceCommandStatus.DISPATCHING },
      ],
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

function normalizedDispatchVersion(value: unknown): number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0
    ? value
    : 0;
}

function incrementDispatchVersion(): () => string {
  return () => '"dispatch_version" + 1';
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
