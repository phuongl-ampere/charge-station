import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddPaymentReservationExpiry implements MigrationInterface {
  name = "AddPaymentReservationExpiry20260908000004";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS expires_at timestamptz",
    );
    await queryRunner.query(
      "UPDATE payment_transactions SET expires_at = created_at + INTERVAL '15 minutes' WHERE expires_at IS NULL",
    );
    await queryRunner.query(
      "ALTER TABLE payment_transactions ALTER COLUMN expires_at SET NOT NULL",
    );
    await queryRunner.query(
      "CREATE INDEX IF NOT EXISTS idx_payment_transactions_pending_expiry ON payment_transactions (expires_at) WHERE status = 'PENDING'",
    );
  }

  async down(): Promise<void> {}
}
