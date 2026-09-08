import { Injectable } from "@nestjs/common";

import type {
  StartChargingCommand,
  StopChargingCommand,
} from "@charge-station/contracts";

const HEALTH_PROBE_TIMEOUT_MS = 1_000;
const DEFAULT_COMMAND_REQUEST_TIMEOUT_MS = 5_000;
const MAX_COMMAND_REQUEST_TIMEOUT_MS = 60_000;

@Injectable()
export class IotServiceClient {
  async start(command: StartChargingCommand): Promise<void> {
    await this.send(command, "start");
  }

  async stop(command: StopChargingCommand): Promise<void> {
    await this.send(command, "stop");
  }

  async isHealthy(): Promise<boolean> {
    const endpoint = this.serviceEndpoint("health");
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async send(
    command: StartChargingCommand | StopChargingCommand,
    action: "start" | "stop",
  ): Promise<void> {
    const serviceToken = process.env.SERVICE_TOKEN;
    if (!serviceToken) {
      throw new Error("SERVICE_TOKEN must be configured");
    }

    const endpoint = this.commandEndpoint(action);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-service-token": serviceToken,
        },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(commandRequestTimeoutMs()),
      });
    } catch {
      throw new IotTransportError("IoT Service command request failed");
    }

    if (!response.ok) {
      if (response.status >= 500) {
        throw new IotTransportError(
          `IoT Service command request failed: ${response.status}`,
        );
      }
      throw new IotCommandRejectedError(
        `IoT Service rejected command: ${response.status}`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new IotCommandRejectedError(
        "IoT Service returned an invalid command response",
      );
    }
    if (
      !isAcceptedCommandResponse(body) ||
      body.commandId !== command.commandId
    ) {
      throw new IotCommandRejectedError("IoT Service rejected command");
    }
  }

  private commandEndpoint(action: "start" | "stop"): string {
    return this.serviceEndpoint(`internal/commands/${action}`);
  }

  private serviceEndpoint(path: string): string {
    const configuredUrl = process.env.IOT_SERVICE_URL;
    if (!configuredUrl) {
      throw new Error("IOT_SERVICE_URL must be configured");
    }

    let baseUrl: URL;
    try {
      baseUrl = new URL(configuredUrl);
    } catch {
      throw new Error("IOT_SERVICE_URL must use a local service destination");
    }

    const hostname = baseUrl.hostname.toLowerCase();
    const localHostnames = new Set([
      "localhost",
      "127.0.0.1",
      "::1",
      "[::1]",
      "iot-service",
    ]);
    if (
      !localHostnames.has(hostname) ||
      !["http:", "https:"].includes(baseUrl.protocol) ||
      baseUrl.username ||
      baseUrl.password
    ) {
      throw new Error("IOT_SERVICE_URL must use a local service destination");
    }

    baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}/${path}`;
    baseUrl.search = "";
    baseUrl.hash = "";
    return baseUrl.toString();
  }
}

export class IotTransportError extends Error {}

export class IotCommandRejectedError extends Error {}

function commandRequestTimeoutMs(): number {
  const configured = Number(process.env.IOT_COMMAND_REQUEST_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_COMMAND_REQUEST_TIMEOUT_MS;
  }
  return Math.min(Math.floor(configured), MAX_COMMAND_REQUEST_TIMEOUT_MS);
}

function isAcceptedCommandResponse(
  body: unknown,
): body is { commandId: string; accepted: true } {
  return (
    typeof body === "object" &&
    body !== null &&
    "commandId" in body &&
    typeof body.commandId === "string" &&
    "accepted" in body &&
    body.accepted === true
  );
}
