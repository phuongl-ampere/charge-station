import { Injectable } from "@nestjs/common";
import type { DeviceEvent } from "@charge-station/contracts";

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
      headers: {
        "content-type": "application/json",
        "x-service-token": serviceToken,
      },
      body: JSON.stringify(event),
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
