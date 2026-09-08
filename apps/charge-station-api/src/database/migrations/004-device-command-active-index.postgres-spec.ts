import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataSource } from "typeorm";

import {
  ChargingSession,
  ChargingSessionStatus,
  Connector,
  ConnectorStatus,
  DeviceCommand,
  DeviceCommandStatus,
  entities,
  migrations,
  Order,
  OrderStatus,
  PricingPlan,
  Station,
} from "../data-source.js";
import { InitialSchemaMigration } from "./001-initial-schema.js";
import { AddDeviceCommandRetryAndSessionState } from "./002-device-command-retry-and-session-state.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://charge:charge@localhost:5432/charge_station";
const schemas: string[] = [];

describe("device command active index migrations with local PostgreSQL", () => {
  let adminDataSource: DataSource;

  beforeAll(async () => {
    adminDataSource = new DataSource({ type: "postgres", url: databaseUrl });
    await adminDataSource.initialize();
  });

  afterAll(async () => {
    for (const schema of schemas) {
      await adminDataSource.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await adminDataSource.destroy();
  });

  it("allows terminal start command history but rejects a second active start command on a fresh install", async () => {
    const dataSource = await createDataSource();
    try {
      await dataSource.runMigrations();
      const { session } = await createFixture(dataSource);
      const commandRepository = dataSource.getRepository(DeviceCommand);

      await commandRepository.save([
        createCommand(session, DeviceCommandStatus.FAILED),
        createCommand(session, DeviceCommandStatus.COMPLETED),
        createCommand(session, DeviceCommandStatus.PENDING),
      ]);

      await expect(
        commandRepository.save(
          createCommand(session, DeviceCommandStatus.ACCEPTED),
        ),
      ).rejects.toThrow();
    } finally {
      await dataSource.destroy();
    }
  });

  it("upgrades an already-applied legacy 003 database with duplicate active commands", async () => {
    const dataSource = await createDataSource();
    try {
      const queryRunner = dataSource.createQueryRunner();
      try {
        await new InitialSchemaMigration().up(queryRunner);
        await new AddDeviceCommandRetryAndSessionState().up(queryRunner);
        await queryRunner.query(`
          CREATE TABLE migrations (
            id SERIAL PRIMARY KEY,
            timestamp bigint NOT NULL,
            name varchar NOT NULL
          )
        `);
        await queryRunner.query(
          `
            INSERT INTO migrations (timestamp, name)
            VALUES
              (260908000000, 'InitialSchemaMigration20260908000000'),
              (260908000001, 'AddDeviceCommandRetryAndSessionState20260908000001'),
              (260908000002, 'AddDeviceCommandSessionTypeUnique20260908000002')
          `,
        );
      } finally {
        await queryRunner.release();
      }

      const { session } = await createFixture(dataSource);
      const accepted = createCommand(session, DeviceCommandStatus.ACCEPTED);
      const pending = createCommand(session, DeviceCommandStatus.PENDING);
      const historical = createCommand(session, DeviceCommandStatus.FAILED);
      for (const command of [accepted, pending, historical]) {
        await dataSource.query(
          [
            "INSERT INTO device_commands (",
            "id, command_id, session_id, command_type, payload, retry_count,",
            "next_attempt_at, status, acknowledged_at",
            ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
          ].join(" "),
          [
            command.id,
            command.commandId,
            command.session.id,
            command.commandType,
            command.payload,
            command.retryCount,
            command.nextAttemptAt,
            command.status,
            command.acknowledgedAt,
          ],
        );
      }

      await dataSource.runMigrations();

      const commandRepository = dataSource.getRepository(DeviceCommand);
      const commands = await commandRepository.find({
        where: { session: { id: session.id } },
        order: { commandId: "ASC" },
      });
      const migratedAccepted = commands.find(
        (command) => command.id === accepted.id,
      );
      const migratedPending = commands.find(
        (command) => command.id === pending.id,
      );
      const migratedHistorical = commands.find(
        (command) => command.id === historical.id,
      );

      expect(migratedAccepted?.status).toBe(DeviceCommandStatus.ACCEPTED);
      expect(migratedPending?.status).toBe(DeviceCommandStatus.FAILED);
      expect(migratedHistorical?.status).toBe(DeviceCommandStatus.FAILED);

      await expect(
        commandRepository.save(
          createCommand(session, DeviceCommandStatus.PENDING),
        ),
      ).rejects.toThrow();
      await expect(
        commandRepository.save(
          createCommand(session, DeviceCommandStatus.FAILED),
        ),
      ).resolves.toMatchObject({ status: DeviceCommandStatus.FAILED });
    } finally {
      await dataSource.destroy();
    }
  });

  async function createDataSource(): Promise<DataSource> {
    const schema = `migration_${randomUUID().replaceAll("-", "")}`;
    schemas.push(schema);
    await adminDataSource.query(`CREATE SCHEMA "${schema}"`);

    const dataSource = new DataSource({
      type: "postgres",
      url: databaseUrl,
      entities,
      migrations,
      migrationsRun: false,
      extra: { options: `-c search_path=${schema},public` },
    });
    await dataSource.initialize();
    return dataSource;
  }
});

async function createFixture(dataSource: DataSource): Promise<{
  session: ChargingSession;
}> {
  const station = await dataSource.getRepository(Station).save({
    id: randomUUID(),
    code: `ST-${randomUUID().slice(0, 8)}`,
    name: "Migration Test Station",
    deviceId: "dev_migration",
  });
  const pricingPlan = await dataSource.getRepository(PricingPlan).save({
    id: randomUUID(),
    name: `Migration Test Pricing ${randomUUID()}`,
    hourlyPriceVnd: 5000,
    allowedDurationsMinutes: [60],
  });
  const connector = await dataSource.getRepository(Connector).save({
    id: randomUUID(),
    code: `ST-C${randomUUID().slice(0, 8)}`,
    status: ConnectorStatus.OCCUPIED,
    station,
    pricingPlan,
  });
  const order = await dataSource.getRepository(Order).save({
    id: randomUUID(),
    durationMinutes: 60,
    amountVnd: 5000,
    currency: "VND",
    status: OrderStatus.PAID,
    user: null,
    connector,
  });
  const session = await dataSource.getRepository(ChargingSession).save({
    id: randomUUID(),
    order,
    connector,
    status: ChargingSessionStatus.START_FAILED,
    startedAt: null,
    expectedEndAt: new Date(Date.now() + 60 * 60_000),
    stoppedAt: null,
    estimatedRemainingSeconds: null,
    lastDeviceEventAt: null,
    operationalWarning: null,
  });
  return { session };
}

function createCommand(
  session: ChargingSession,
  status: DeviceCommandStatus,
): DeviceCommand {
  return {
    id: randomUUID(),
    commandId: randomUUID(),
    session,
    commandType: "START_CHARGING",
    payload: {
      stationCode: session.connector.station.code,
      connectorCode: session.connector.code,
      deviceId: session.connector.station.deviceId,
      sessionId: session.id,
      durationSeconds: 3600,
      expiresAt: session.expectedEndAt?.toISOString(),
      configVersion: 1,
    },
    retryCount: 0,
    nextAttemptAt: null,
    status,
    acknowledgedAt: null,
  } as DeviceCommand;
}
