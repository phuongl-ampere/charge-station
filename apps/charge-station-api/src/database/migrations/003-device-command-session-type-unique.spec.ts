import { describe, expect, it, vi } from "vitest";
import type { QueryRunner } from "typeorm";

import { AddDeviceCommandSessionTypeUnique } from "./003-device-command-session-type-unique.js";

describe("AddDeviceCommandSessionTypeUnique", () => {
  it("enforces one command of each type for every charging session", async () => {
    const query = vi.fn().mockResolvedValue(undefined);
    const migration = new AddDeviceCommandSessionTypeUnique();

    await migration.up({ query } as unknown as QueryRunner);
    await migration.down({ query } as unknown as QueryRunner);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UNIQUE (session_id, command_type)"),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "DROP CONSTRAINT uq_device_commands_session_command_type",
      ),
    );
  });
});
