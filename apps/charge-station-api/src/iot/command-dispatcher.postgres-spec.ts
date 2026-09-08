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
import { CommandDispatcherService } from "./command-dispatcher.service.js";
import type { IotServiceClient } from "./iot-service.client.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://charge:charge@localhost:5432/charge_station";
const schema = "dispatch_claim_" + randomUUID().replaceAll("-", "");

describe("CommandDispatcherService claim concurrency with local PostgreSQL", () => {
  let adminDataSource: DataSource;
  let dataSource: DataSource;
  let command: DeviceCommand;

  beforeAll(async () => {
    adminDataSource = new DataSource({ type: "postgres", url: databaseUrl });
    await adminDataSource.initialize();
    await adminDataSource.query('CREATE SCHEMA "' + schema + '"');
    dataSource = new DataSource({
      type: "postgres",
      url: databaseUrl,
      entities,
      migrations,
      migrationsRun: false,
      extra: { options: "-c search_path=" + schema + ",public" },
    });
    await dataSource.initialize();
    await dataSource.runMigrations();

    const station = await dataSource.getRepository(Station).save({
      id: randomUUID(),
      code: "ST01",
      name: "Dispatch Claim Station",
      deviceId: "dev_ST01",
    });
    const pricingPlan = await dataSource.getRepository(PricingPlan).save({
      id: randomUUID(),
      name: "Dispatch Claim Pricing",
      hourlyPriceVnd: 5000,
      allowedDurationsMinutes: [60],
    });
    const connector = await dataSource.getRepository(Connector).save({
      id: randomUUID(),
      code: "ST01-C01",
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
      status: ChargingSessionStatus.PENDING,
      startedAt: null,
      expectedEndAt: new Date(Date.now() + 60 * 60_000),
      stoppedAt: null,
      estimatedRemainingSeconds: null,
      lastDeviceEventAt: null,
      operationalWarning: null,
    });
    command = await dataSource.getRepository(DeviceCommand).save({
      id: randomUUID(),
      commandId: randomUUID(),
      session,
      commandType: "START_CHARGING",
      payload: {
        stationCode: station.code,
        connectorCode: connector.code,
        deviceId: station.deviceId,
        sessionId: session.id,
        durationSeconds: 3600,
        expiresAt: session.expectedEndAt!.toISOString(),
        configVersion: 1,
      },
      retryCount: 0,
      nextAttemptAt: null,
      status: DeviceCommandStatus.PENDING,
      acknowledgedAt: null,
    });
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    if (adminDataSource?.isInitialized) {
      await adminDataSource.query(
        'DROP SCHEMA IF EXISTS "' + schema + '" CASCADE',
      );
      await adminDataSource.destroy();
    }
  });

  it("sends a command once when two dispatchers race for its claim", async () => {
    let markStarted: (() => void) | undefined;
    let releaseSend: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const iotClient = {
      start: vi.fn(async () => {
        markStarted?.();
        await sendGate;
      }),
    };
    const first = new CommandDispatcherService(
      dataSource,
      iotClient as unknown as IotServiceClient,
    );
    const second = new CommandDispatcherService(
      dataSource,
      iotClient as unknown as IotServiceClient,
    );

    const firstDispatch = first.dispatch(command.commandId);
    await started;
    const secondDispatch = second.dispatch(command.commandId);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(iotClient.start).toHaveBeenCalledTimes(1);

    releaseSend?.();
    await Promise.all([firstDispatch, secondDispatch]);
    expect(
      (await dataSource.getRepository(DeviceCommand).findOneByOrFail({
        id: command.id,
      })).status,
    ).toBe(DeviceCommandStatus.SENT);
    first.onApplicationShutdown();
    second.onApplicationShutdown();
  });
});
