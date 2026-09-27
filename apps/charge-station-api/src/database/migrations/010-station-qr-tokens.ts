import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddStationQrTokens implements MigrationInterface {
  name = "AddStationQrTokens20260927000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      [
        "CREATE TABLE IF NOT EXISTS station_qr_tokens (",
        "station_id uuid PRIMARY KEY REFERENCES stations(id) ON DELETE CASCADE,",
        "qr_version integer NOT NULL,",
        "token_hash varchar(64) NOT NULL UNIQUE,",
        "created_at timestamptz NOT NULL DEFAULT now()",
        ")",
      ].join(" "),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DROP TABLE IF EXISTS station_qr_tokens");
  }
}
