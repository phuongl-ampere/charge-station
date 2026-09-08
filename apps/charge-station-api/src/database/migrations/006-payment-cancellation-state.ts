import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddPaymentCancellationState implements MigrationInterface {
  name = "AddPaymentCancellationState20260908000005";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS cancellation_status varchar",
    );
    await queryRunner.query(
      "ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS cancellation_attempts integer",
    );
    await queryRunner.query(
      "ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS cancellation_last_attempt_at timestamptz",
    );
    await queryRunner.query(
      "ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS cancellation_next_attempt_at timestamptz",
    );
    await queryRunner.query(
      "ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS cancellation_last_error varchar",
    );
    await queryRunner.query(
      "ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS cancellation_claim_token varchar",
    );
    await queryRunner.query(
      "ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS cancellation_claimed_at timestamptz",
    );
    await queryRunner.query(
      "UPDATE payment_transactions SET cancellation_status = 'NONE' WHERE cancellation_status IS NULL",
    );
    await queryRunner.query(
      "UPDATE payment_transactions SET cancellation_attempts = 0 WHERE cancellation_attempts IS NULL",
    );
    await queryRunner.query(
      "ALTER TABLE payment_transactions ALTER COLUMN cancellation_status SET DEFAULT 'NONE'",
    );
    await queryRunner.query(
      "ALTER TABLE payment_transactions ALTER COLUMN cancellation_status SET NOT NULL",
    );
    await queryRunner.query(
      "ALTER TABLE payment_transactions ALTER COLUMN cancellation_attempts SET DEFAULT 0",
    );
    await queryRunner.query(
      "ALTER TABLE payment_transactions ALTER COLUMN cancellation_attempts SET NOT NULL",
    );
    await queryRunner.query(
      "CREATE INDEX IF NOT EXISTS idx_payment_transactions_pending_cancellation ON payment_transactions (cancellation_next_attempt_at) WHERE status = 'PENDING' AND cancellation_status = 'PENDING'",
    );
  }

  async down(): Promise<void> {}
}
