import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type {
  DeviceEvent,
  StartChargingCommand,
} from "@charge-station/contracts";

export type DeviceRuntimeStatus = "STARTING" | "RUNNING" | "STOPPED";
export type RelayState = "ON" | "OFF";
export type CommandResponseStatus = "ACCEPTED" | "REJECTED" | "STOPPED";

export interface PendingTerminalDelivery {
  event: DeviceEvent;
  retryCount: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  retryResolver?: () => void;
}

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
  terminalDeliveries: Map<string, PendingTerminalDelivery>;
}

export interface CommandResponse {
  commandId: string;
  accepted: boolean;
  deviceId: string;
  status: CommandResponseStatus;
}

@Injectable()
export class DeviceStateService implements OnModuleDestroy {
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
      terminalDeliveries: new Map(),
    };
    this.commands.set(command.commandId, state);
    this.connectors.set(command.connectorCode, state);
    return state;
  }

  saveStopResponse(commandId: string, response: CommandResponse): void {
    this.stopResponses.set(commandId, response);
  }

  createTerminalDelivery(
    state: DeviceRuntimeState,
    event: DeviceEvent,
  ): PendingTerminalDelivery {
    const existing = state.terminalDeliveries.get(event.eventId);
    if (existing) {
      return existing;
    }

    const delivery: PendingTerminalDelivery = {
      event,
      retryCount: 0,
    };
    state.terminalDeliveries.set(event.eventId, delivery);
    return delivery;
  }

  getTerminalDelivery(
    state: DeviceRuntimeState,
    eventId: string,
  ): PendingTerminalDelivery | undefined {
    return state.terminalDeliveries.get(eventId);
  }

  acknowledgeTerminalDelivery(
    state: DeviceRuntimeState,
    eventId: string,
  ): void {
    const delivery = state.terminalDeliveries.get(eventId);
    if (!delivery) {
      return;
    }

    this.cancelTerminalRetry(delivery);
    state.terminalDeliveries.delete(eventId);
  }

  waitForTerminalRetry(
    delivery: PendingTerminalDelivery,
    delayMs: number,
  ): Promise<void> {
    delivery.retryCount += 1;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (delivery.retryTimer === timer) {
          delivery.retryTimer = undefined;
          delivery.retryResolver = undefined;
        }
        resolve();
      }, delayMs);
      delivery.retryTimer = timer;
      delivery.retryResolver = () => {
        if (delivery.retryTimer === timer) {
          clearTimeout(timer);
          delivery.retryTimer = undefined;
        }
        delivery.retryResolver = undefined;
        resolve();
      };
      (timer as unknown as { unref?: () => void }).unref?.();
    });
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

  onModuleDestroy(): void {
    for (const state of this.commands.values()) {
      this.clearTimers(state);
      for (const delivery of state.terminalDeliveries.values()) {
        this.cancelTerminalRetry(delivery);
      }
      state.terminalDeliveries.clear();
    }
    this.connectors.clear();
    this.stopResponses.clear();
  }

  private cancelTerminalRetry(delivery: PendingTerminalDelivery): void {
    delivery.retryResolver?.();
  }
}
