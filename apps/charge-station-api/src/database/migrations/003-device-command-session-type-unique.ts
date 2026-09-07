import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddDeviceCommandSessionTypeUnique implements MigrationInterface {
  name = "AddDeviceCommandSessionTypeUnique20260908000002";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE device_commands ADD CONSTRAINT uq_device_commands_session_command_type UNIQUE (session_id, command_type)",
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE device_commands DROP CONSTRAINT uq_device_commands_session_command_type",
    );
  }
}
