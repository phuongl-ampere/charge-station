import { Injectable } from "@nestjs/common";
import type { StartChargingCommand } from "@charge-station/contracts";

export type DeviceRuntimeStatus = "STARTING" | "RUNNING" | "STOPPED";
export type RelayState = "ON" | "OFF";
export type CommandResponseStatus = "ACCEPTED" | "REJECTED" | "STOPPED";

export interface DeviceRuntimeState {
  command: StartChargingCommand;
  deviceId: string;
  status: DeviceRuntimeStatus;
  relayState: RelayState;
  startedAt?: number;
  startTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  stopTimer?: ReturnType<typeof setTimeout>;
  stoppedEventSent: boolean;
}

export interface CommandResponse {
  commandId: string;
  accepted: boolean;
  deviceId: string;
  status: CommandResponseStatus;
}

@Injectable()
export class DeviceStateService {
  private readonly commands = new Map<string, DeviceRuntimeState>();
  private readonly connectors = new Map<string, DeviceRuntimeState>();
  private readonly stopResponses = new Map<string, CommandResponse>();

  getCommand(commandId: string): DeviceRuntimeState | undefined {
    return this.commands.get(commandId);
  }

  getConnector(connectorCode: string): DeviceRuntimeState | undefined {
    return this.connectors.get(connectorCode);
  }

  getSession(sessionId: string): DeviceRuntimeState | undefined {
    for (const state of this.commands.values()) {
      if (state.command.sessionId === sessionId && state.status !== "STOPPED") {
        return state;
      }
    }
    return undefined;
  }

  getStopResponse(commandId: string): CommandResponse | undefined {
    return this.stopResponses.get(commandId);
  }

  add(command: StartChargingCommand, deviceId: string): DeviceRuntimeState {
    const state: DeviceRuntimeState = {
      command,
      deviceId,
      status: "STARTING",
      relayState: "OFF",
      stoppedEventSent: false,
    };
    this.commands.set(command.commandId, state);
    this.connectors.set(command.connectorCode, state);
    return state;
  }

  saveStopResponse(commandId: string, response: CommandResponse): void {
    this.stopResponses.set(commandId, response);
  }

  clearTimers(state: DeviceRuntimeState): void {
    if (state.startTimer) {
      clearTimeout(state.startTimer);
      state.startTimer = undefined;
    }
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = undefined;
    }
    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
      state.stopTimer = undefined;
    }
  }

  stop(state: DeviceRuntimeState): void {
    this.clearTimers(state);
    state.status = "STOPPED";
    state.relayState = "OFF";
    if (this.connectors.get(state.command.connectorCode) === state) {
      this.connectors.delete(state.command.connectorCode);
    }
  }
}
