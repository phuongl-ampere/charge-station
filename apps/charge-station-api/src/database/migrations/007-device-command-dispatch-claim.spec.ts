import { describe, expect, it, vi } from "vitest";
import type { QueryRunner } from "typeorm";

import { AddDeviceCommandDispatchClaim } from "./007-device-command-dispatch-claim.js";

describe("AddDeviceCommandDispatchClaim", () => {
  it("adds claim token, lease timestamp, version, and keeps dispatching commands active", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const migration = new AddDeviceCommandDispatchClaim();

    await migration.up({ query } as unknown as QueryRunner);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "ADD COLUMN IF NOT EXISTS dispatch_claim_token varchar",
      ),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "ADD COLUMN IF NOT EXISTS dispatch_claimed_at timestamptz",
      ),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "ADD COLUMN IF NOT EXISTS dispatch_version integer",
      ),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("'DISPATCHING'"),
    );
  });
});
