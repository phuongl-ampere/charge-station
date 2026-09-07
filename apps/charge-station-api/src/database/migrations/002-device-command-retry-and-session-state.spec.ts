import { describe, expect, it, vi } from "vitest";
import type { QueryRunner } from "typeorm";

import { AddDeviceCommandRetryAndSessionState } from "./002-device-command-retry-and-session-state.js";

describe("AddDeviceCommandRetryAndSessionState", () => {
  it("adds durable retry scheduling and current charging-session fields", async () => {
    const query = vi.fn().mockResolvedValue(undefined);
    const migration = new AddDeviceCommandRetryAndSessionState();

    await migration.up({ query } as unknown as QueryRunner);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "ALTER TABLE device_commands ADD COLUMN next_attempt_at timestamptz",
      ),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "ALTER TABLE charging_sessions ADD COLUMN estimated_remaining_seconds integer",
      ),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "ALTER TABLE charging_sessions ADD COLUMN last_device_event_at timestamptz",
      ),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "ALTER TABLE charging_sessions ADD COLUMN operational_warning varchar",
      ),
    );
  });
});
