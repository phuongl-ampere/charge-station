import type { MigrationInterface, QueryRunner } from "typeorm";

export class RenameDeviceHoldToDeviceUsage implements MigrationInterface {
  name = "RenameDeviceHoldToDeviceUsage20260927010000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE stations RENAME COLUMN device_hold TO device_in_use",
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE stations RENAME COLUMN device_in_use TO device_hold",
    );
  }
}
