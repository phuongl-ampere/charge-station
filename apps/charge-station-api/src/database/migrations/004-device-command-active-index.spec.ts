import { describe, expect, it, vi } from "vitest";
import type { QueryRunner } from "typeorm";

import { AddActiveDeviceCommandSessionTypeUnique } from "./004-device-command-active-index.js";

describe("AddActiveDeviceCommandSessionTypeUnique", () => {
  it("replaces the legacy constraint after normalizing duplicate active commands", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const migration = new AddActiveDeviceCommandSessionTypeUnique();

    await migration.up({ query } as unknown as QueryRunner);
    await migration.down({ query } as unknown as QueryRunner);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "ALTER TABLE device_commands DROP CONSTRAINT IF EXISTS uq_device_commands_session_command_type",
      ),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "SELECT id, session_id, command_type, status, created_at",
      ),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_device_commands_active_session_command_type",
      ),
    );
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining(
        "DROP INDEX IF EXISTS uq_device_commands_active_session_command_type",
      ),
    );
  });
});
