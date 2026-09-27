import type { MigrationInterface, QueryRunner } from "typeorm";

export class MoveUsageStateToManagedDevices implements MigrationInterface {
  name = "MoveUsageStateToManagedDevices20260927020000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE managed_devices (
        device_id varchar PRIMARY KEY,
        availability varchar NOT NULL DEFAULT 'AVAILABLE',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_managed_devices_availability
          CHECK (availability IN ('AVAILABLE', 'IN_USE'))
      )
    `);
    await queryRunner.query(`
      INSERT INTO managed_devices (device_id, availability)
      SELECT device_id,
        CASE WHEN device_in_use THEN 'IN_USE' ELSE 'AVAILABLE' END
      FROM stations
      WHERE device_id IS NOT NULL
      ON CONFLICT (device_id) DO NOTHING
    `);
    await queryRunner.query("ALTER TABLE stations DROP COLUMN device_in_use");
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE stations ADD COLUMN device_in_use boolean NOT NULL DEFAULT false",
    );
    await queryRunner.query(`
      UPDATE stations
      SET device_in_use = managed_devices.availability = 'IN_USE'
      FROM managed_devices
      WHERE managed_devices.device_id = stations.device_id
    `);
    await queryRunner.query("DROP TABLE managed_devices");
  }
}
