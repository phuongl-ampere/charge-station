import { describe, expect, it, vi } from "vitest";
import type { QueryRunner } from "typeorm";

import { AddPaymentCancellationState } from "./006-payment-cancellation-state.js";

describe("AddPaymentCancellationState", () => {
  it("persists cancellation status, attempts, retry timing, and a claim lease", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const migration = new AddPaymentCancellationState();

    await migration.up({ query } as unknown as QueryRunner);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "ADD COLUMN IF NOT EXISTS cancellation_status varchar",
      ),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "ADD COLUMN IF NOT EXISTS cancellation_attempts integer",
      ),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "ADD COLUMN IF NOT EXISTS cancellation_next_attempt_at timestamptz",
      ),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "ADD COLUMN IF NOT EXISTS cancellation_claim_token varchar",
      ),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "idx_payment_transactions_pending_cancellation",
      ),
    );
  });
});
