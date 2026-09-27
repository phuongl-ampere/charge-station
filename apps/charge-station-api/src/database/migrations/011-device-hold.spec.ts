import { describe, expect, it, vi } from "vitest";
import type { QueryRunner } from "typeorm";

import { AddDeviceHoldAndRemoveRelaySchedule } from "./011-device-hold.js";

describe("AddDeviceHoldAndRemoveRelaySchedule", () => {
  it("removes schedule columns and adds a non-null device hold flag", async () => {
    const query = vi.fn().mockResolvedValue([]);

    await new AddDeviceHoldAndRemoveRelaySchedule().up(
      { query } as unknown as QueryRunner,
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("DROP COLUMN IF EXISTS relay_schedule"),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("ADD COLUMN IF NOT EXISTS device_hold boolean"),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("uq_stations_device_id"),
    );
  });
});
