import {
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import type { StartChargingCommand } from "@charge-station/contracts";
import { DataSource } from "typeorm";

import { DeviceCommand, DeviceCommandStatus } from "../database/data-source.js";
import {
  IotCommandRejectedError,
  IotServiceClient,
} from "./iot-service.client.js";

const RETRY_DELAYS_MS = [1_000, 5_000, 20_000] as const;

@Injectable()
export class CommandDispatcherService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CommandDispatcherService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly iotServiceClient: IotServiceClient,
  ) {}

  onApplicationBootstrap(): void {
    void this.dispatchPending().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Unable to dispatch pending IoT commands: ${message}`);
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

    const startCommand = toStartChargingCommand(command);
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        await this.iotServiceClient.start(startCommand);
        command.status = DeviceCommandStatus.SENT;
        await commandRepository.save(command);
        return;
      } catch (error: unknown) {
        if (
          error instanceof IotCommandRejectedError ||
          attempt === RETRY_DELAYS_MS.length
        ) {
          command.status = DeviceCommandStatus.FAILED;
          await commandRepository.save(command);
          throw error;
        }

        command.retryCount += 1;
        await commandRepository.save(command);
        await this.wait(RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  protected wait(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
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

function readString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value) {
    throw new Error("Persisted device command has an invalid start payload");
  }
  return value;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value > 0;
}
