import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  DeviceEvent,
  StartChargingCommand,
  StopChargingCommand,
} from "@charge-station/contracts";

import {
  type CommandResponse,
  DeviceStateService,
  type DeviceRuntimeState,
  type PendingTerminalDelivery,
} from "../devices/device-state.service.js";
import { ChargeStationEventClient } from "../events/charge-station-event.client.js";

type FailureMode = "none" | "timeout" | "offline" | "command_failed";
type StopReason =
  | StopChargingCommand["reason"]
  | "TIMER_EXPIRED"
  | "TIMEOUT"
  | "COMMAND_FAILED"
  | "DEVICE_OFFLINE";

const TERMINAL_EVENT_TYPES = new Set<DeviceEvent["type"]>([
  "DEVICE_OFFLINE",
  "COMMAND_FAILED",
  "STOPPED",
]);
const TERMINAL_RETRY_DELAYS_MS = [100, 500, 1_000] as const;

@Injectable()
export class CommandsService {
  private readonly logger = new Logger(CommandsService.name);
  private readonly eventQueues = new Map<string, Promise<void>>();

  constructor(
    @Inject(ChargeStationEventClient)
    private readonly eventClient: ChargeStationEventClient,
    @Inject(DeviceStateService)
    private readonly deviceState: DeviceStateService = new DeviceStateService(),
  ) {}

  async start(command: StartChargingCommand): Promise<CommandResponse> {
    if (!hasUnexpiredStartExpiry(command.expiresAt)) {
      return {
        commandId: command.commandId,
        accepted: false,
        deviceId: this.deviceIdFor(command),
        status: "REJECTED",
      };
    }

    const duplicate = this.deviceState.getCommand(command.commandId);
    if (duplicate) {
      return this.acceptedResponse(duplicate);
    }

    const occupied = this.deviceState.getConnector(command.connectorCode);
    if (occupied && occupied.status !== "STOPPED") {
      return {
        commandId: command.commandId,
        accepted: false,
        deviceId: occupied.deviceId,
        status: "REJECTED",
      };
    }

    if (
      !Number.isInteger(command.durationSeconds) ||
      command.durationSeconds <= 0
    ) {
      return {
        commandId: command.commandId,
        accepted: false,
        deviceId: this.deviceIdFor(command),
        status: "REJECTED",
      };
    }

    const state = this.deviceState.add(command, this.deviceIdFor(command));
    state.startTimer = setTimeout(() => {
      this.activate(state);
    }, this.startDelayMs());

    this.postEvent(state, "COMMAND_ACCEPTED", {
      relayState: state.relayState,
    });

    return this.acceptedResponse(state);
  }

  async stop(command: StopChargingCommand): Promise<CommandResponse> {
    const duplicate = this.deviceState.getStopResponse(command.commandId);
    if (duplicate) {
      return duplicate;
    }

    const state = this.deviceState.getSession(command.sessionId);
    if (!state) {
      const response: CommandResponse = {
        commandId: command.commandId,
        accepted: false,
        deviceId: "unknown",
        status: "REJECTED",
      };
      this.deviceState.saveStopResponse(command.commandId, response);
      return response;
    }

    this.deviceState.stop(state);
    const response: CommandResponse = {
      commandId: command.commandId,
      accepted: true,
      deviceId: state.deviceId,
      status: "STOPPED",
    };
    this.deviceState.saveStopResponse(command.commandId, response);
    this.postStopped(state, command.reason);
    return response;
  }

  private activate(state: DeviceRuntimeState): void {
    if (state.status !== "STARTING") {
      return;
    }

    const failureMode = this.failureMode();
    if (failureMode !== "none") {
      this.deviceState.stop(state);
      const reason =
        failureMode === "timeout"
          ? "TIMEOUT"
          : failureMode === "offline"
            ? "DEVICE_OFFLINE"
            : "COMMAND_FAILED";
      if (failureMode === "offline") {
        this.postEvent(state, "DEVICE_OFFLINE", {
          reason: "DEVICE_OFFLINE",
          relayState: state.relayState,
        });
      }
      this.postEvent(state, "COMMAND_FAILED", {
        reason,
        relayState: state.relayState,
      });
      this.postStopped(state, reason);
      return;
    }

    state.status = "RUNNING";
    state.relayState = "ON";
    state.startedAt = Date.now();

    state.stopTimer = setTimeout(() => {
      this.expire(state);
    }, state.command.durationSeconds * 1000);

    state.heartbeatTimer = setInterval(() => {
      const remainingSeconds = Math.max(
        0,
        Math.ceil(
          (state.command.durationSeconds * 1000 -
            (Date.now() - (state.startedAt ?? Date.now()))) /
            1000,
        ),
      );
      this.postEvent(state, "HEARTBEAT", {
        remainingSeconds,
        relayState: state.relayState,
      });
    }, this.heartbeatIntervalMs());

    this.postEvent(state, "RUNNING", {
      remainingSeconds: state.command.durationSeconds,
      relayState: state.relayState,
    });
  }

  private expire(state: DeviceRuntimeState): void {
    if (state.status !== "RUNNING" || state.stoppedEventSent) {
      return;
    }

    this.deviceState.stop(state);
    this.postStopped(state, "TIMER_EXPIRED");
  }

  private postStopped(state: DeviceRuntimeState, reason: StopReason): void {
    if (state.stoppedEventSent) {
      return;
    }
    state.stoppedEventSent = true;
    this.postEvent(state, "STOPPED", {
      reason,
      relayState: state.relayState,
    });
  }

  private postEvent(
    state: DeviceRuntimeState,
    type: DeviceEvent["type"],
    payload: Record<string, unknown>,
  ): void {
    const event: DeviceEvent = {
      eventId: randomUUID(),
      commandId: state.command.commandId,
      sessionId: state.command.sessionId,
      deviceId: state.deviceId,
      connectorCode: state.command.connectorCode,
      type,
      occurredAt: new Date().toISOString(),
      payload,
    };

    if (TERMINAL_EVENT_TYPES.has(type)) {
      const delivery = this.deviceState.createTerminalDelivery(state, event);
      this.enqueueEvent(event.sessionId, () =>
        this.deliverTerminalEvent(state, delivery),
      );
      return;
    }

    this.enqueueEvent(event.sessionId, async () => {
      try {
        await this.eventClient.post(event);
      } catch (error: unknown) {
        this.logEventDeliveryFailure(event, error);
      }
    });
  }

  private enqueueEvent(sessionId: string, deliver: () => Promise<void>): void {
    const previousDelivery =
      this.eventQueues.get(sessionId) ?? Promise.resolve();
    const delivery = previousDelivery.then(deliver);

    this.eventQueues.set(sessionId, delivery);
    void delivery.then(
      () => {
        if (this.eventQueues.get(sessionId) === delivery) {
          this.eventQueues.delete(sessionId);
        }
      },
      () => {
        if (this.eventQueues.get(sessionId) === delivery) {
          this.eventQueues.delete(sessionId);
        }
      },
    );
  }

  private async deliverTerminalEvent(
    state: DeviceRuntimeState,
    delivery: PendingTerminalDelivery,
  ): Promise<void> {
    while (
      this.deviceState.getTerminalDelivery(state, delivery.event.eventId) ===
      delivery
    ) {
      try {
        await this.eventClient.post(delivery.event);
        this.deviceState.acknowledgeTerminalDelivery(
          state,
          delivery.event.eventId,
        );
        return;
      } catch (error: unknown) {
        this.logEventDeliveryFailure(delivery.event, error);
        await this.deviceState.waitForTerminalRetry(
          delivery,
          this.terminalRetryDelay(delivery.retryCount),
        );
      }
    }
  }

  private terminalRetryDelay(retryCount: number): number {
    return TERMINAL_RETRY_DELAYS_MS[
      Math.min(retryCount, TERMINAL_RETRY_DELAYS_MS.length - 1)
    ];
  }

  private logEventDeliveryFailure(event: DeviceEvent, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(
      `Failed to deliver ${event.type} device event: ${message}`,
    );
  }

  private acceptedResponse(state: DeviceRuntimeState): CommandResponse {
    return {
      commandId: state.command.commandId,
      accepted: true,
      deviceId: state.deviceId,
      status: "ACCEPTED",
    };
  }

  private deviceIdFor(command: StartChargingCommand): string {
    return `dev_${command.stationCode}`;
  }

  private startDelayMs(): number {
    return this.envNumber("MOCK_IOT_START_DELAY_MS", 100);
  }

  private heartbeatIntervalMs(): number {
    return this.envNumber("MOCK_IOT_HEARTBEAT_MS", 1000);
  }

  private failureMode(): FailureMode {
    const value = process.env.MOCK_IOT_FAILURE_MODE;
    return value === "timeout" ||
      value === "offline" ||
      value === "command_failed"
      ? value
      : "none";
  }

  private envNumber(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }
}

function hasUnexpiredStartExpiry(expiresAt: unknown): boolean {
  if (typeof expiresAt !== "string") {
    return false;
  }

  const expiry = new Date(expiresAt);
  return (
    !Number.isNaN(expiry.valueOf()) &&
    expiry.toISOString() === expiresAt &&
    expiry.valueOf() > Date.now()
  );
}
