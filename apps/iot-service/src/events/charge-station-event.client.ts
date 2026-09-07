import { Injectable } from "@nestjs/common";
import type { DeviceEvent } from "@charge-station/contracts";

@Injectable()
export class ChargeStationEventClient {
  async post(event: DeviceEvent): Promise<void> {
    const baseUrl =
      process.env.CHARGE_STATION_API_URL ?? "http://localhost:4000";
    const serviceToken = process.env.SERVICE_TOKEN ?? "";
    const response = await fetch(
      `${baseUrl.replace(/\/$/, "")}/internal/device-events`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-service-token": serviceToken,
        },
        body: JSON.stringify(event),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Charge Station rejected device event: ${response.status}`,
      );
    }
  }
}
