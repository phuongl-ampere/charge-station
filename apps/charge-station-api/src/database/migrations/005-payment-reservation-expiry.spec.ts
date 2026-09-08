import { describe, expect, it, vi } from "vitest";
import type { QueryRunner } from "typeorm";

import { AddPaymentReservationExpiry } from "./005-payment-reservation-expiry.js";

describe("AddPaymentReservationExpiry", () => {
  it("backfills only missing expiries and indexes pending reservations", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const migration = new AddPaymentReservationExpiry();

    await migration.up({ query } as unknown as QueryRunner);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS expires_at timestamptz",
      ),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "SET expires_at = created_at + INTERVAL '15 minutes' WHERE expires_at IS NULL",
      ),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "CREATE INDEX IF NOT EXISTS idx_payment_transactions_pending_expiry",
      ),
    );
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'EXPIRED'"),
    );
  });
});
