import { Injectable } from "@nestjs/common";
import type { DeviceEvent } from "@charge-station/contracts";

const DEFAULT_EVENT_REQUEST_TIMEOUT_MS = 3_000;
const MAX_EVENT_REQUEST_TIMEOUT_MS = 60_000;

@Injectable()
export class ChargeStationEventClient {
  async post(event: DeviceEvent): Promise<void> {
    const serviceToken = process.env.SERVICE_TOKEN;
    if (!serviceToken) {
      throw new Error("SERVICE_TOKEN must be configured");
    }

    const endpoint = this.callbackEndpoint();
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "x-service-token": serviceToken,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(eventRequestTimeoutMs()),
    });

    if (!response.ok) {
      throw new Error(
        `Charge Station rejected device event: ${response.status}`,
      );
    }
  }

  private callbackEndpoint(): string {
    const configuredUrl =
      process.env.CHARGE_STATION_API_URL ?? "http://localhost:4000";
    let baseUrl: URL;

    try {
      baseUrl = new URL(configuredUrl);
    } catch {
      throw new Error(
        "CHARGE_STATION_API_URL must use a local callback destination",
      );
    }

    const hostname = baseUrl.hostname.toLowerCase();
    const localHostnames = new Set([
      "localhost",
      "127.0.0.1",
      "::1",
      "[::1]",
      "charge-station-api",
    ]);

    if (
      !localHostnames.has(hostname) ||
      !["http:", "https:"].includes(baseUrl.protocol) ||
      baseUrl.username ||
      baseUrl.password
    ) {
      throw new Error(
        "CHARGE_STATION_API_URL must use a local callback destination",
      );
    }

    baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}/internal/device-events`;
    baseUrl.search = "";
    baseUrl.hash = "";
    return baseUrl.toString();
  }
}

function eventRequestTimeoutMs(): number {
  const configured = Number(process.env.IOT_EVENT_REQUEST_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_EVENT_REQUEST_TIMEOUT_MS;
  }
  return Math.min(configured, MAX_EVENT_REQUEST_TIMEOUT_MS);
}
