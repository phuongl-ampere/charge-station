import { describe, expect, it, vi } from "vitest";
import type { QueryRunner } from "typeorm";

import { AddStationQrVersion } from "./008-station-qr-version.js";

describe("AddStationQrVersion", () => {
  it("adds a non-null version that invalidates rotated station QR tokens", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const migration = new AddStationQrVersion();

    await migration.up({ query } as unknown as QueryRunner);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "ALTER TABLE stations ADD COLUMN IF NOT EXISTS qr_version integer",
      ),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "UPDATE stations SET qr_version = 1 WHERE qr_version IS NULL",
      ),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "ALTER TABLE stations ALTER COLUMN qr_version SET NOT NULL",
      ),
    );
  });
});
