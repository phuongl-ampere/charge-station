import { describe, expect, it, vi } from "vitest";

import { DevicesController } from "./devices.controller.js";
import type { DevicesService } from "./devices.service.js";

describe("DevicesController", () => {
  it("delegates device list, usage actions, and relay control", async () => {
    const devices = {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({ deviceId: "device-1" }),
      setInUse: vi.fn().mockResolvedValue({ deviceId: "device-1", inUse: true }),
      controlRelay: vi.fn().mockResolvedValue({ relayId: "relay-1" }),
    };
    const controller = new DevicesController(devices as unknown as DevicesService);

    await expect(controller.list()).resolves.toEqual([]);
    await expect(controller.get("device-1")).resolves.toEqual({ deviceId: "device-1" });
    await expect(controller.occupy("device-1")).resolves.toEqual({
      deviceId: "device-1",
      inUse: true,
    });
    await controller.controlRelay("device-1", "relay-1", {
      enabled: true,
      durationSeconds: 60,
    });
    expect(devices.setInUse).toHaveBeenCalledWith("device-1", true);
    expect(devices.controlRelay).toHaveBeenCalledWith("device-1", "relay-1", {
      enabled: true,
      durationSeconds: 60,
    });
  });
});
