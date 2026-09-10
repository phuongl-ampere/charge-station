import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddStationQrVersion implements MigrationInterface {
  name = "AddStationQrVersion20260910000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE stations ADD COLUMN IF NOT EXISTS qr_version integer",
    );
    await queryRunner.query(
      "UPDATE stations SET qr_version = 1 WHERE qr_version IS NULL",
    );
    await queryRunner.query(
      "ALTER TABLE stations ALTER COLUMN qr_version SET DEFAULT 1",
    );
    await queryRunner.query(
      "ALTER TABLE stations ALTER COLUMN qr_version SET NOT NULL",
    );
  }

  async down(): Promise<void> {}
}
