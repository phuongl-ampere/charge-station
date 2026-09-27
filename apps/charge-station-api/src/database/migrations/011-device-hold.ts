import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddDeviceHoldAndRemoveRelaySchedule implements MigrationInterface {
  name = "AddDeviceHoldAndRemoveRelaySchedule20260927000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("ALTER TABLE stations DROP COLUMN IF EXISTS relay_schedule");
    await queryRunner.query(
      "ALTER TABLE stations DROP COLUMN IF EXISTS relay_schedule_version",
    );
    await queryRunner.query(
      "ALTER TABLE stations ADD COLUMN IF NOT EXISTS device_hold boolean",
    );
    await queryRunner.query(
      "UPDATE stations SET device_hold = false WHERE device_hold IS NULL",
    );
    await queryRunner.query(
      "ALTER TABLE stations ALTER COLUMN device_hold SET DEFAULT false",
    );
    await queryRunner.query(
      "ALTER TABLE stations ALTER COLUMN device_hold SET NOT NULL",
    );
    await queryRunner.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_stations_device_id ON stations (device_id) WHERE device_id IS NOT NULL",
    );
  }

  async down(): Promise<void> {}
}
