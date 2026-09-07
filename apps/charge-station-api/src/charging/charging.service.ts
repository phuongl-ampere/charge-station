import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";

import {
  ChargingSession,
  DeviceCommand,
  DeviceCommandStatus,
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
      const sessionRepository = manager.getRepository(ChargingSession);
      const commandRepository = manager.getRepository(DeviceCommand);
      const session = await sessionRepository.findOneBy({ id });
      if (!session) {
        throw new NotFoundException("Charging session not found");
      }

      const existingCommand = await commandRepository.findOne({
        where: {
          session: { id: session.id },
          commandType: "STOP_CHARGING",
        },
      });
      if (existingCommand) {
        return existingCommand.commandId;
      }

      const command = commandRepository.create({
        id: randomUUID(),
        commandId: randomUUID(),
        session,
        commandType: "STOP_CHARGING",
        payload: {
          sessionId: session.id,
          reason: "USER_REQUESTED",
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

  private dispatchStopCommand(commandId: string): void {
    if (!this.commandDispatcher) {
      this.logger.error(
        `Failed to dispatch stop command ${commandId}: dispatcher unavailable`,
      );
      return;
    }

    void this.commandDispatcher.dispatch(commandId).catch((error: unknown) => {
      const errorDetails =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      this.logger.error(
        `Failed to dispatch stop command ${commandId}`,
        errorDetails,
      );
    });
  }
}
