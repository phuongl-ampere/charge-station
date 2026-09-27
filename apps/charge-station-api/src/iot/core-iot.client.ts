export interface CoreRelayCommand {
  commandId: string;
  deviceId: string;
  relayId: string;
  enabled: boolean;
  durationSeconds?: number;
  sessionId?: string;
}

export interface CoreRelayResult {
  commandId: string;
  relayId: string;
  enabled: boolean;
  remainingSeconds: number | null;
}

export interface CoreTelemetry {
  eventAt: string;
  relayState: boolean | null;
  sessionId: string | null;
  remainingSeconds: number | null;
  lastStopReason: string | null;
  voltageV: number | null;
  currentA: number | null;
  powerW: number | null;
  energyKwh: number | null;
  totalPowerW: number | null;
  totalEnergyKwh: number | null;
  relays: Record<string, CoreRelayTelemetry> | null;
}

export interface CoreRelayTelemetry {
  enabled: boolean | null;
  remainingSeconds: number | null;
  voltageV: number | null;
  currentA: number | null;
  powerW: number | null;
  energyKwh: number | null;
  source: string | null;
}

export class CoreIotTransportError extends Error {}

export class CoreIotCommandRejectedError extends Error {}

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_POLL_MS = 250;
const MAX_COMMAND_TIMEOUT_MS = 60_000;
const MAX_COMMAND_POLL_MS = 5_000;

export class CoreIotClient {
  async isHealthy(): Promise<boolean> {
    try {
      await this.requestJson("/api/v1/devices?limit=1", { method: "GET" }, "probe Core IoT");
      return true;
    } catch {
      return false;
    }
  }

  async setRelay(input: CoreRelayCommand): Promise<CoreRelayResult> {
    const created = await this.requestJson(
      `/api/v1/devices/${encodeURIComponent(input.deviceId)}/commands`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": input.commandId,
        },
        body: JSON.stringify({
          method: "setRelay",
          mode: "two_way",
          params: {
            relayId: input.relayId,
            enabled: input.enabled,
            ...(input.durationSeconds === undefined
              ? {}
              : { durationSeconds: input.durationSeconds }),
            ...(input.sessionId === undefined
              ? {}
              : { sessionId: input.sessionId }),
          },
        }),
      },
      "create command",
    );
    const commandId = requiredString(created, "id", "Core command response");
    return this.waitForRelayResponse(commandId, input);
  }

  async latestTelemetry(deviceId: string): Promise<CoreTelemetry | null> {
    const now = new Date();
    const from = new Date(now.valueOf() - 15 * 60_000);
    const url = new URL(
      `/api/v1/telemetry/${encodeURIComponent(deviceId)}`,
      this.baseUrl(),
    );
    url.searchParams.set("from", from.toISOString());
    url.searchParams.set("to", now.toISOString());
    url.searchParams.set("limit", "100");
    const page = await this.requestJson(
      url.pathname + url.search,
      { method: "GET" },
      "read telemetry",
    );
    if (!isRecord(page) || !Array.isArray(page.items) || page.items.length === 0) {
      return null;
    }
    const latest = page.items.at(-1);
    if (
      !isRecord(latest) ||
      typeof latest.event_at !== "string" ||
      !isRecord(latest.measurements)
    ) {
      return null;
    }
    const measurements = latest.measurements;
    return {
      eventAt: latest.event_at,
      relayState: booleanValue(measurements, "relay_state"),
      sessionId: stringValue(measurements, "session_id"),
      remainingSeconds: numberValue(measurements, "remaining_seconds"),
      lastStopReason: stringValue(measurements, "last_stop_reason"),
      voltageV: numberValue(measurements, "voltage_v"),
      currentA: numberValue(measurements, "current_a"),
      powerW: numberValue(measurements, "power_w"),
      energyKwh: numberValue(measurements, "energy_kwh"),
      totalPowerW: numberValue(measurements, "total_power_w"),
      totalEnergyKwh: numberValue(measurements, "total_energy_kwh"),
      relays: relayTelemetry(measurements.relays),
    };
  }

  private async waitForRelayResponse(
    commandId: string,
    input: CoreRelayCommand,
  ): Promise<CoreRelayResult> {
    const deadline = Date.now() + commandTimeoutMs();
    do {
      const command = await this.requestJson(
        `/api/v1/commands/${encodeURIComponent(commandId)}`,
        { method: "GET" },
        "read command",
      );
      const state = isRecord(command) && typeof command.state === "string"
        ? command.state
        : undefined;
      if (state === "responded") {
        return relayResult(command, input, commandId);
      }
      if (state === "expired" || state === "failed") {
        throw new CoreIotCommandRejectedError(
          `Core command ${commandId} ended in ${state}`,
        );
      }
      if (Date.now() >= deadline) {
        break;
      }
      await delay(commandPollMs());
    } while (Date.now() < deadline);

    throw new CoreIotTransportError(
      `Core command ${commandId} did not respond before timeout`,
    );
  }

  private async requestJson(
    path: string,
    init: RequestInit,
    description: string,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.baseUrl()).toString(), {
        ...init,
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.accessToken()}`,
          ...init.headers,
        },
        signal: AbortSignal.timeout(commandTimeoutMs()),
      });
    } catch {
      throw new CoreIotTransportError(`Unable to ${description} through Core IoT`);
    }
    if (!response.ok) {
      if (response.status >= 500) {
        throw new CoreIotTransportError(
          `Core IoT ${description} failed: ${response.status}`,
        );
      }
      throw new CoreIotCommandRejectedError(
        `Core IoT ${description} rejected: ${response.status}`,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new CoreIotCommandRejectedError(
        `Core IoT ${description} returned invalid JSON`,
      );
    }
  }

  private baseUrl(): URL {
    const configured = process.env.IOT_CORE_PUBLIC_URL?.trim();
    if (!configured) {
      throw new Error("IOT_CORE_PUBLIC_URL must be configured");
    }
    let url: URL;
    try {
      url = new URL(configured);
    } catch {
      throw new Error("IOT_CORE_PUBLIC_URL must be an absolute HTTP URL");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      throw new Error("IOT_CORE_PUBLIC_URL must be an absolute HTTP URL");
    }
    return url;
  }

  private accessToken(): string {
    const token = process.env.IOT_CORE_ACCESS_TOKEN?.trim();
    if (!token) {
      throw new Error("IOT_CORE_ACCESS_TOKEN must be configured");
    }
    return token;
  }
}

function relayResult(
  command: unknown,
  input: CoreRelayCommand,
  commandId: string,
): CoreRelayResult {
  if (!isRecord(command) || !isRecord(command.response) || command.response.ok !== true) {
    throw new CoreIotCommandRejectedError(
      `Core command ${commandId} returned an unsuccessful device response`,
    );
  }
  const result = isRecord(command.response.result) ? command.response.result : {};
  if (result.enabled !== input.enabled) {
    throw new CoreIotCommandRejectedError(
      `Core command ${commandId} did not confirm requested relay state`,
    );
  }
  return {
    commandId,
    relayId: typeof result.relayId === "string" ? result.relayId : input.relayId,
    enabled: input.enabled,
    remainingSeconds: numberValue(result, "remainingSeconds"),
  };
}

function requiredString(value: unknown, key: string, description: string): string {
  if (!isRecord(value) || typeof value[key] !== "string" || !value[key]) {
    throw new CoreIotCommandRejectedError(`${description} is invalid`);
  }
  return value[key];
}

function numberValue(
  value: Record<string, unknown>,
  key: string,
): number | null {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : null;
}

function stringValue(
  value: Record<string, unknown>,
  key: string,
): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function booleanValue(
  value: Record<string, unknown>,
  key: string,
): boolean | null {
  return typeof value[key] === "boolean" ? value[key] : null;
}

function relayTelemetry(value: unknown): Record<string, CoreRelayTelemetry> | null {
  if (!isRecord(value)) {
    return null;
  }
  const relays: Record<string, CoreRelayTelemetry> = {};
  for (const [relayId, reading] of Object.entries(value)) {
    if (!isRecord(reading)) {
      continue;
    }
    relays[relayId] = {
      enabled: booleanValue(reading, "enabled"),
      remainingSeconds: numberValue(reading, "remaining_seconds"),
      voltageV: numberValue(reading, "voltage_v"),
      currentA: numberValue(reading, "current_a"),
      powerW: numberValue(reading, "power_w"),
      energyKwh: numberValue(reading, "energy_kwh"),
      source: stringValue(reading, "source"),
    };
  }
  return relays;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function commandTimeoutMs(): number {
  return envMilliseconds(
    "IOT_CORE_COMMAND_TIMEOUT_MS",
    DEFAULT_COMMAND_TIMEOUT_MS,
    MAX_COMMAND_TIMEOUT_MS,
  );
}

function commandPollMs(): number {
  return envMilliseconds(
    "IOT_CORE_COMMAND_POLL_MS",
    DEFAULT_COMMAND_POLL_MS,
    MAX_COMMAND_POLL_MS,
  );
}

function envMilliseconds(name: string, fallback: number, maximum: number): number {
  const configured = Number(process.env[name]);
  if (!Number.isFinite(configured) || configured <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(configured), maximum);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
