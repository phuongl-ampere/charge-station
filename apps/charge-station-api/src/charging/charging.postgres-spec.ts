import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
} from "../database/data-source.js";
import type { CommandDispatcherService } from "../iot/command-dispatcher.service.js";
import { ChargingService } from "./charging.service.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://charge:charge@localhost:5432/charge_station";
const schema = `reliability_${randomUUID().replaceAll("-", "")}`;

describe("Charging reliability with local PostgreSQL", () => {
  let adminDataSource: DataSource;
  let dataSource: DataSource;
  let station: Station;
  let pricingPlan: PricingPlan;

  beforeAll(async () => {
    adminDataSource = new DataSource({ type: "postgres", url: databaseUrl });
    await adminDataSource.initialize();
    await adminDataSource.query(`CREATE SCHEMA "${schema}"`);

    dataSource = new DataSource({
      type: "postgres",
      url: databaseUrl,
      entities,
      migrations,
      migrationsRun: false,
      extra: { options: `-c search_path=${schema},public` },
    });
    await dataSource.initialize();
    await dataSource.runMigrations();

    station = await dataSource.getRepository(Station).save({
      id: randomUUID(),
      code: "ST01",
      name: "Reliability Test Station",
      deviceId: "dev_ST01",
    });
    pricingPlan = await dataSource.getRepository(PricingPlan).save({
      id: randomUUID(),
      name: "Reliability Test Pricing",
      hourlyPriceVnd: 5000,
      allowedDurationsMinutes: [60, 120],
    });
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    if (adminDataSource?.isInitialized) {
      await adminDataSource.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await adminDataSource.destroy();
    }
  });

  it("reuses a persisted failed start command after a transport outage", async () => {
    const fixture = await createFixture(
      ChargingSessionStatus.START_FAILED,
      ConnectorStatus.AVAILABLE,
      DeviceCommandStatus.FAILED,
    );
    const dispatcher = { dispatch: vi.fn().mockResolvedValue(undefined) };
    const service = new ChargingService(
      dataSource,
      dispatcher as unknown as CommandDispatcherService,
    );

    await expect(service.retryStart(fixture.session.id)).resolves.toEqual({
      accepted: true,
    });

    const commands = await dataSource.getRepository(DeviceCommand).find({
      where: { session: { id: fixture.session.id } },
    });
    const session = await dataSource
      .getRepository(ChargingSession)
      .findOneByOrFail({ id: fixture.session.id });
    const connector = await dataSource
      .getRepository(Connector)
      .findOneByOrFail({ id: fixture.connector.id });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      id: fixture.command.id,
      commandId: fixture.command.commandId,
      payload: fixture.command.payload,
      status: DeviceCommandStatus.PENDING,
      retryCount: 0,
      nextAttemptAt: null,
      acknowledgedAt: null,
    });
    expect(session.status).toBe(ChargingSessionStatus.PENDING);
    expect(connector.status).toBe(ConnectorStatus.OCCUPIED);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(fixture.command.commandId);
  });

  it("serializes concurrent stops and enforces one command of each type per session", async () => {
    const fixture = await createFixture(
      ChargingSessionStatus.CHARGING,
      ConnectorStatus.OCCUPIED,
      DeviceCommandStatus.SENT,
    );
    const dispatcher = { dispatch: vi.fn().mockResolvedValue(undefined) };
    const service = new ChargingService(
      dataSource,
      dispatcher as unknown as CommandDispatcherService,
    );

    await expect(
      Promise.all([
        service.stopSession(fixture.session.id),
        service.stopSession(fixture.session.id),
      ]),
    ).resolves.toEqual([{ accepted: true }, { accepted: true }]);

    const commands = await dataSource.getRepository(DeviceCommand).find({
      where: { session: { id: fixture.session.id } },
      order: { commandType: "ASC" },
    });
    const session = await dataSource
      .getRepository(ChargingSession)
      .findOneByOrFail({ id: fixture.session.id });

    expect(commands).toHaveLength(2);
    expect(
      commands.filter((command) => command.commandType === "START_CHARGING"),
    ).toHaveLength(1);
    expect(
      commands.filter((command) => command.commandType === "STOP_CHARGING"),
    ).toHaveLength(1);
    expect(session.status).toBe(ChargingSessionStatus.STOPPING);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.stringMatching(/.+/),
    );

    await expect(
      dataSource.getRepository(DeviceCommand).save({
        id: randomUUID(),
        commandId: randomUUID(),
        session,
        commandType: "STOP_CHARGING",
        payload: {
          sessionId: session.id,
          reason: "USER_REQUESTED",
        },
        retryCount: 0,
        nextAttemptAt: null,
        status: DeviceCommandStatus.PENDING,
        acknowledgedAt: null,
      }),
    ).rejects.toThrow();
  });

  async function createFixture(
    status: ChargingSessionStatus,
    connectorStatus: ConnectorStatus,
    commandStatus: DeviceCommandStatus,
  ): Promise<{
    connector: Connector;
    session: ChargingSession;
    command: DeviceCommand;
  }> {
    const connector = await dataSource.getRepository(Connector).save({
      id: randomUUID(),
      code: `ST01-C${randomUUID().slice(0, 8)}`,
      status: connectorStatus,
      station,
      pricingPlan,
    });
    const order = await dataSource.getRepository(Order).save({
      id: randomUUID(),
      durationMinutes: 120,
      amountVnd: 10000,
      currency: "VND",
      status: OrderStatus.PAID,
      user: null,
      connector,
    });
    const expectedEndAt = new Date(Date.now() + 60 * 60_000);
    const session = await dataSource.getRepository(ChargingSession).save({
      id: randomUUID(),
      order,
      connector,
      status,
      startedAt: null,
      expectedEndAt,
      stoppedAt: null,
      estimatedRemainingSeconds: null,
      lastDeviceEventAt: null,
      operationalWarning: null,
    });
    const command = await dataSource.getRepository(DeviceCommand).save({
      id: randomUUID(),
      commandId: randomUUID(),
      session,
      commandType: "START_CHARGING",
      payload: {
        stationCode: station.code,
        connectorCode: connector.code,
        deviceId: station.deviceId,
        sessionId: session.id,
        durationSeconds: 7200,
        expiresAt: expectedEndAt.toISOString(),
        configVersion: 1,
      },
      retryCount: commandStatus === DeviceCommandStatus.FAILED ? 3 : 0,
      nextAttemptAt: null,
      status: commandStatus,
      acknowledgedAt: null,
    });
    return { connector, session, command };
  }
});
