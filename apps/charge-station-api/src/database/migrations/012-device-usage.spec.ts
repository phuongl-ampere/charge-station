import { describe, expect, it, vi } from "vitest";
import type { QueryRunner } from "typeorm";

import { RenameDeviceHoldToDeviceUsage } from "./012-device-usage.js";

describe("RenameDeviceHoldToDeviceUsage", () => {
  it("renames the persisted hold column to the device usage column", async () => {
    const query = vi.fn().mockResolvedValue([]);

    await new RenameDeviceHoldToDeviceUsage().up(
      { query } as unknown as QueryRunner,
    );

    expect(query).toHaveBeenCalledWith(
      "ALTER TABLE stations RENAME COLUMN device_hold TO device_in_use",
    );
  });
});
