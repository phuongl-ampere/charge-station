import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddDeviceCommandDispatchClaim implements MigrationInterface {
  name = "AddDeviceCommandDispatchClaim20260908000006";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS dispatch_claim_token varchar",
    );
    await queryRunner.query(
      "ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS dispatch_claimed_at timestamptz",
    );
    await queryRunner.query(
      "ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS dispatch_version integer",
    );
    await queryRunner.query(
      "UPDATE device_commands SET dispatch_version = 0 WHERE dispatch_version IS NULL",
    );
    await queryRunner.query(
      "ALTER TABLE device_commands ALTER COLUMN dispatch_version SET DEFAULT 0",
    );
    await queryRunner.query(
      "ALTER TABLE device_commands ALTER COLUMN dispatch_version SET NOT NULL",
    );
    await queryRunner.query(
      "DROP INDEX IF EXISTS uq_device_commands_active_session_command_type",
    );
    await queryRunner.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_device_commands_active_session_command_type ON device_commands (session_id, command_type) WHERE status IN ('PENDING', 'DISPATCHING', 'SENT', 'ACCEPTED')",
    );
  }

  async down(): Promise<void> {}
}
