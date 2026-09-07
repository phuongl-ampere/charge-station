import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type {
  DeviceEvent,
  StartChargingCommand,
  StopChargingCommand,
} from "@charge-station/contracts";

import {
  type CommandResponse,
  DeviceStateService,
  type DeviceRuntimeState,
} from "../devices/device-state.service.js";
import { ChargeStationEventClient } from "../events/charge-station-event.client.js";

type FailureMode = "none" | "timeout" | "offline" | "command_failed";

@Injectable()
export class CommandsService {
  constructor(
    @Inject(ChargeStationEventClient)
    private readonly eventClient: ChargeStationEventClient,
    private readonly deviceState: DeviceStateService = new DeviceStateService(),
  ) {}

  async start(command: StartChargingCommand): Promise<CommandResponse> {
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
    await this.postEvent(state, "COMMAND_ACCEPTED", {
      relayState: state.relayState,
    });

    state.startTimer = setTimeout(() => {
      void this.activate(state);
    }, this.startDelayMs());

    return this.acceptedResponse(state);
  }

  async stop(command: StopChargingCommand): Promise<CommandResponse> {
    const duplicate = this.deviceState.getStopResponse(command.commandId);
    if (duplicate) {
      return duplicate;
    }

    const state = this.deviceState.getSession(command.sessionId);
    if (!state) {
      const response = {
        commandId: command.commandId,
        accepted: false,
        deviceId: "unknown",
        status: "REJECTED",
      };
      this.deviceState.saveStopResponse(command.commandId, response);
      return response;
    }

    this.deviceState.stop(state);
    const response = {
      commandId: command.commandId,
      accepted: true,
      deviceId: state.deviceId,
      status: "STOPPED",
    };
    this.deviceState.saveStopResponse(command.commandId, response);
    await this.postStopped(state, command.reason);
    return response;
  }

  private async activate(state: DeviceRuntimeState): Promise<void> {
    if (state.status !== "STARTING") {
      return;
    }

    const failureMode = this.failureMode();
    if (failureMode !== "none") {
      this.deviceState.stop(state);
      if (failureMode === "offline") {
        await this.postEvent(state, "DEVICE_OFFLINE", {
          reason: "DEVICE_OFFLINE",
          relayState: state.relayState,
        });
      } else {
        await this.postEvent(state, "COMMAND_FAILED", {
          reason: failureMode === "timeout" ? "TIMEOUT" : "COMMAND_FAILED",
          relayState: state.relayState,
        });
      }
      return;
    }

    state.status = "RUNNING";
    state.relayState = "ON";
    state.startedAt = Date.now();
    await this.postEvent(state, "RUNNING", {
      remainingSeconds: state.command.durationSeconds,
      relayState: state.relayState,
    });

    state.heartbeatTimer = setInterval(() => {
      const remainingSeconds = Math.max(
        0,
        Math.ceil(
          (state.command.durationSeconds * 1000 -
            (Date.now() - (state.startedAt ?? Date.now()))) /
            1000,
        ),
      );
      void this.postEvent(state, "HEARTBEAT", {
        remainingSeconds,
        relayState: state.relayState,
      });
    }, this.heartbeatIntervalMs());

    state.stopTimer = setTimeout(() => {
      void this.expire(state);
    }, state.command.durationSeconds * 1000);
  }

  private async expire(state: DeviceRuntimeState): Promise<void> {
    if (state.status !== "RUNNING" || state.stoppedEventSent) {
      return;
    }

    this.deviceState.stop(state);
    await this.postStopped(state, "TIMER_EXPIRED");
  }

  private async postStopped(
    state: DeviceRuntimeState,
    reason: string,
  ): Promise<void> {
    if (state.stoppedEventSent) {
      return;
    }
    state.stoppedEventSent = true;
    await this.postEvent(state, "STOPPED", {
      reason,
      relayState: state.relayState,
    });
  }

  private async postEvent(
    state: DeviceRuntimeState,
    type: DeviceEvent["type"],
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.eventClient.post({
      eventId: randomUUID(),
      commandId: state.command.commandId,
      sessionId: state.command.sessionId,
      deviceId: state.deviceId,
      connectorCode: state.command.connectorCode,
      type,
      occurredAt: new Date().toISOString(),
      payload,
    });
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
