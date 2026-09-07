import {
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import type {
  StartChargingCommand,
  StopChargingCommand,
} from "@charge-station/contracts";
import { DataSource, Repository } from "typeorm";

import { DeviceCommand, DeviceCommandStatus } from "../database/data-source.js";
import { IotServiceClient, IotTransportError } from "./iot-service.client.js";

const RETRY_DELAYS_MS = [1_000, 5_000, 20_000] as const;

@Injectable()
export class CommandDispatcherService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CommandDispatcherService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly iotServiceClient: IotServiceClient,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.dispatchPending();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Unable to dispatch pending IoT commands: ${message}`);
    }
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
      await this.markFailed(command, commandRepository);
      throw error;
    }

    while (true) {
      try {
        await this.waitForScheduledAttempt(command);
      } catch (error: unknown) {
        await this.markFailed(command, commandRepository);
        throw error;
      }
      try {
        await this.send(commandPayload);
        command.status = DeviceCommandStatus.SENT;
        command.nextAttemptAt = null;
        await commandRepository.save(command);
        return;
      } catch (error: unknown) {
        if (!(error instanceof IotTransportError)) {
          await this.markFailed(command, commandRepository);
          throw error;
        }

        if (
          !Number.isInteger(command.retryCount) ||
          command.retryCount < 0 ||
          command.retryCount >= RETRY_DELAYS_MS.length
        ) {
          await this.markFailed(command, commandRepository);
          throw error;
        }

        const delayMs = RETRY_DELAYS_MS[command.retryCount];
        command.retryCount += 1;
        command.nextAttemptAt = new Date(Date.now() + delayMs);
        await commandRepository.save(command);
        await this.wait(delayMs);
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
