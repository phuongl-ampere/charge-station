import { describe, expect, it, vi } from "vitest";
import type { QueryRunner } from "typeorm";

import { MoveUsageStateToManagedDevices } from "./013-managed-device-availability.js";

describe("MoveUsageStateToManagedDevices", () => {
  it("moves station usage state into managed device availability", async () => {
    const query = vi.fn().mockResolvedValue([]);

    await new MoveUsageStateToManagedDevices().up(
      { query } as unknown as QueryRunner,
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("CREATE TABLE managed_devices"),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("CASE WHEN device_in_use THEN 'IN_USE'"),
    );
    expect(query).toHaveBeenCalledWith(
      "ALTER TABLE stations DROP COLUMN device_in_use",
    );
  });
});
