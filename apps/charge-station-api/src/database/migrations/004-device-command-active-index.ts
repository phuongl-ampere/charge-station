import type { MigrationInterface, QueryRunner } from "typeorm";

interface ActiveCommandRow {
  id: string;
  session_id: string;
  command_type: string;
  status: string;
  created_at: Date | string;
}

export class AddActiveDeviceCommandSessionTypeUnique
  implements MigrationInterface
{
  name = "AddActiveDeviceCommandSessionTypeUnique20260908000003";

  async up(queryRunner: QueryRunner): Promise<void> {
    const activeCommands = (await queryRunner.query(`
      SELECT id, session_id, command_type, status, created_at
      FROM device_commands
      WHERE status IN ('PENDING', 'SENT', 'ACCEPTED')
    `)) as ActiveCommandRow[];
    const duplicateCommandIds = activeCommands
      .sort(compareActiveCommands)
      .filter(
        (command, index, commands) =>
          index > 0 &&
          command.session_id === commands[index - 1].session_id &&
          command.command_type === commands[index - 1].command_type,
      )
      .map((command) => command.id);

    for (const commandId of duplicateCommandIds) {
      await queryRunner.query(
        "UPDATE device_commands SET status = 'FAILED', next_attempt_at = NULL, updated_at = now() WHERE id = $1",
        [commandId],
      );
    }
    await queryRunner.query(
      "ALTER TABLE device_commands DROP CONSTRAINT IF EXISTS uq_device_commands_session_command_type",
    );
    await queryRunner.query(
      "DROP INDEX IF EXISTS uq_device_commands_session_command_type",
    );
    await queryRunner.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_device_commands_active_session_command_type ON device_commands (session_id, command_type) WHERE status IN ('PENDING', 'SENT', 'ACCEPTED')",
    );
  }

  async down(): Promise<void> {}
}

function compareActiveCommands(
  left: ActiveCommandRow,
  right: ActiveCommandRow,
): number {
  return (
    left.session_id.localeCompare(right.session_id) ||
    left.command_type.localeCompare(right.command_type) ||
    activeStatusPriority(right.status) - activeStatusPriority(left.status) ||
    new Date(right.created_at).valueOf() - new Date(left.created_at).valueOf() ||
    right.id.localeCompare(left.id)
  );
}

function activeStatusPriority(status: string): number {
  if (status === "ACCEPTED") {
    return 3;
  }
  if (status === "SENT") {
    return 2;
  }
  return 1;
}
