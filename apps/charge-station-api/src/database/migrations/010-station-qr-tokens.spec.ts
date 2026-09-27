import { describe, expect, it, vi } from "vitest";
import type { QueryRunner } from "typeorm";

import { AddStationQrTokens } from "./010-station-qr-tokens.js";

describe("AddStationQrTokens", () => {
  it("stores only one hashed opaque token mapping for each station", async () => {
    const query = vi.fn().mockResolvedValue([]);

    await new AddStationQrTokens().up({ query } as unknown as QueryRunner);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("CREATE TABLE IF NOT EXISTS station_qr_tokens"),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("token_hash varchar(64) NOT NULL UNIQUE"),
    );
  });
});
