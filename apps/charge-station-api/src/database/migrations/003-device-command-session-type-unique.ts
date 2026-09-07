import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddDeviceCommandSessionTypeUnique implements MigrationInterface {
  name = "AddDeviceCommandSessionTypeUnique20260908000002";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "CREATE UNIQUE INDEX uq_device_commands_active_session_command_type ON device_commands (session_id, command_type) WHERE status IN ('PENDING', 'SENT', 'ACCEPTED')",
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "DROP INDEX uq_device_commands_active_session_command_type",
    );
  }
}
