import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDeviceCommandRetryAndSessionState
  implements MigrationInterface
{
  name = 'AddDeviceCommandRetryAndSessionState20260908000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE device_commands ADD COLUMN next_attempt_at timestamptz',
    );
    await queryRunner.query(
      'ALTER TABLE charging_sessions ADD COLUMN estimated_remaining_seconds integer',
    );
    await queryRunner.query(
      'ALTER TABLE charging_sessions ADD COLUMN last_device_event_at timestamptz',
    );
    await queryRunner.query(
      'ALTER TABLE charging_sessions ADD COLUMN operational_warning varchar',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE charging_sessions DROP COLUMN operational_warning',
    );
    await queryRunner.query(
      'ALTER TABLE charging_sessions DROP COLUMN last_device_event_at',
    );
    await queryRunner.query(
      'ALTER TABLE charging_sessions DROP COLUMN estimated_remaining_seconds',
    );
    await queryRunner.query(
      'ALTER TABLE device_commands DROP COLUMN next_attempt_at',
    );
  }
}
