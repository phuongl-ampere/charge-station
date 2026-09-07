import { describe, expect, it, vi } from "vitest";
import type { QueryRunner } from "typeorm";

import { AddDeviceCommandSessionTypeUnique } from "./003-device-command-session-type-unique.js";

describe("AddDeviceCommandSessionTypeUnique", () => {
  it("enforces one active command of each type for every charging session", async () => {
    const query = vi.fn().mockResolvedValue(undefined);
    const migration = new AddDeviceCommandSessionTypeUnique();

    await migration.up({ query } as unknown as QueryRunner);
    await migration.down({ query } as unknown as QueryRunner);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "CREATE UNIQUE INDEX uq_device_commands_active_session_command_type",
      ),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "WHERE status IN ('PENDING', 'SENT', 'ACCEPTED')",
      ),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "DROP INDEX uq_device_commands_active_session_command_type",
      ),
    );
  });
});
