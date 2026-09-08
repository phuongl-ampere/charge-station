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
import { CommandDispatcherService } from "../iot/command-dispatcher.service.js";
import {
  IotServiceClient,
  IotTransportError,
} from "../iot/iot-service.client.js";
import type { PayosClient } from "../payments/payos.client.js";
import { PaymentsService } from "../payments/payments.service.js";
import { ChargingService } from "./charging.service.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://charge:charge@localhost:5432/charge_station";
const schema = `reliability_${randomUUID().replaceAll("-", "")}`;

class ImmediateCommandDispatcherService extends CommandDispatcherService {
  protected override async wait(): Promise<void> {}
}

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

  it("creates a fresh start command while preserving a failed start command audit record", async () => {
    const fixture = await createFixture(
      ChargingSessionStatus.START_FAILED,
      ConnectorStatus.AVAILABLE,
      DeviceCommandStatus.FAILED,
    );
    const dispatcher = { dispatchWhenIotReady: vi.fn() };
    const service = new ChargingService(
      dataSource,
      dispatcher as unknown as CommandDispatcherService,
    );

    await expect(service.retryStart(fixture.session.id)).resolves.toEqual({
      accepted: true,
    });

    const commands = await dataSource.getRepository(DeviceCommand).find({
      where: { session: { id: fixture.session.id } },
      order: { createdAt: "ASC" },
    });
    const session = await dataSource
      .getRepository(ChargingSession)
      .findOneByOrFail({ id: fixture.session.id });
    const connector = await dataSource
      .getRepository(Connector)
      .findOneByOrFail({ id: fixture.connector.id });

    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({
      id: fixture.command.id,
      commandId: fixture.command.commandId,
      payload: fixture.command.payload,
      status: DeviceCommandStatus.FAILED,
      retryCount: 3,
      nextAttemptAt: null,
      acknowledgedAt: null,
    });
    expect(commands[1]).toMatchObject({
      commandType: "START_CHARGING",
      payload: fixture.command.payload,
      status: DeviceCommandStatus.PENDING,
      retryCount: 0,
      nextAttemptAt: null,
      acknowledgedAt: null,
    });
    expect(commands[1].id).not.toBe(fixture.command.id);
    expect(commands[1].commandId).not.toBe(fixture.command.commandId);
    expect(session.status).toBe(ChargingSessionStatus.PENDING);
    expect(connector.status).toBe(ConnectorStatus.OCCUPIED);
    expect(dispatcher.dispatchWhenIotReady).toHaveBeenCalledWith(
      commands[1].commandId,
    );
  });

  it("keeps a retried start pending at retry zero until IoT health recovers", async () => {
    const fixture = await createFixture(
      ChargingSessionStatus.START_FAILED,
      ConnectorStatus.AVAILABLE,
      DeviceCommandStatus.FAILED,
    );
    const iotClient = {
      isHealthy: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    };
    const dispatcher = new ImmediateCommandDispatcherService(
      dataSource,
      iotClient as unknown as IotServiceClient,
    );
    const service = new ChargingService(dataSource, dispatcher);

    vi.useFakeTimers();
    try {
      await expect(service.retryStart(fixture.session.id)).resolves.toEqual({
        accepted: true,
      });
      await Promise.resolve();
      await Promise.resolve();

      const pendingCommand = await dataSource
        .getRepository(DeviceCommand)
        .findOneByOrFail({
          session: { id: fixture.session.id },
          status: DeviceCommandStatus.PENDING,
        });
      expect(iotClient.isHealthy).toHaveBeenCalledTimes(1);
      expect(iotClient.start).not.toHaveBeenCalled();
      expect(pendingCommand).toMatchObject({ retryCount: 0, nextAttemptAt: null });

      await vi.advanceTimersByTimeAsync(250);

      const dispatchedCommand = await dataSource
        .getRepository(DeviceCommand)
        .findOneByOrFail({ id: pendingCommand.id });
      expect(iotClient.isHealthy).toHaveBeenCalledTimes(2);
      expect(iotClient.start).toHaveBeenCalledTimes(1);
      expect(dispatchedCommand).toMatchObject({
        status: DeviceCommandStatus.SENT,
        retryCount: 0,
        nextAttemptAt: null,
      });
    } finally {
      dispatcher.onApplicationShutdown();
      vi.useRealTimers();
    }
  });

  it("keeps a stop command pending at retry zero until IoT health recovers", async () => {
    const fixture = await createFixture(
      ChargingSessionStatus.CHARGING,
      ConnectorStatus.OCCUPIED,
      DeviceCommandStatus.SENT,
    );
    const iotClient = {
      isHealthy: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const dispatcher = new ImmediateCommandDispatcherService(
      dataSource,
      iotClient as unknown as IotServiceClient,
    );
    const service = new ChargingService(dataSource, dispatcher);

    try {
      await expect(service.stopSession(fixture.session.id)).resolves.toEqual({
        accepted: true,
      });
      await expect.poll(() => iotClient.isHealthy.mock.calls.length).toBe(1);

      const pendingCommand = await dataSource
        .getRepository(DeviceCommand)
        .findOneByOrFail({
          session: { id: fixture.session.id },
          commandType: "STOP_CHARGING",
        });
      expect(iotClient.isHealthy).toHaveBeenCalledTimes(1);
      expect(iotClient.stop).not.toHaveBeenCalled();
      expect(pendingCommand).toMatchObject({
        status: DeviceCommandStatus.PENDING,
        retryCount: 0,
        nextAttemptAt: null,
      });

      await expect
        .poll(() => iotClient.stop.mock.calls.length, {
          interval: 10,
          timeout: 1_000,
        })
        .toBe(1);
      expect(iotClient.isHealthy).toHaveBeenCalledTimes(2);
    } finally {
      dispatcher.onApplicationShutdown();
    }
  });

  it("retains connector allocation after an ambiguous start transport outage", async () => {
    const fixture = await createFixture(
      ChargingSessionStatus.PENDING,
      ConnectorStatus.OCCUPIED,
      DeviceCommandStatus.PENDING,
    );
    const dispatcher = new ImmediateCommandDispatcherService(dataSource, {
      start: vi
        .fn()
        .mockRejectedValue(new IotTransportError("connection refused")),
      stop: vi.fn(),
    } as unknown as IotServiceClient);

    await expect(
      dispatcher.dispatch(fixture.command.commandId),
    ).rejects.toThrow("connection refused");

    const session = await dataSource
      .getRepository(ChargingSession)
      .findOneByOrFail({ id: fixture.session.id });
    const connector = await dataSource
      .getRepository(Connector)
      .findOneByOrFail({ id: fixture.connector.id });
    expect(session).toMatchObject({
      status: ChargingSessionStatus.DEVICE_OFFLINE,
      operationalWarning: "START_STATE_UNKNOWN",
    });
    expect(connector.status).toBe(ConnectorStatus.OCCUPIED);

    const paymentsService = new PaymentsService(dataSource, {} as PayosClient);
    await expect(
      paymentsService.createOrder({
        connectorCode: fixture.connector.code,
        durationMinutes: 60,
      }),
    ).rejects.toThrow("Connector is not available");
    expect(
      await dataSource
        .getRepository(Order)
        .countBy({ connector: { id: fixture.connector.id } }),
    ).toBe(1);
  });

  it("serializes concurrent stops while preserving terminal stop command history", async () => {
    const fixture = await createFixture(
      ChargingSessionStatus.CHARGING,
      ConnectorStatus.OCCUPIED,
      DeviceCommandStatus.SENT,
    );
    await dataSource.getRepository(DeviceCommand).save({
      id: randomUUID(),
      commandId: randomUUID(),
      session: fixture.session,
      commandType: "STOP_CHARGING",
      payload: {
        sessionId: fixture.session.id,
        reason: "USER_REQUESTED",
      },
      retryCount: 0,
      nextAttemptAt: null,
      status: DeviceCommandStatus.FAILED,
      acknowledgedAt: null,
    });
    const dispatcher = { dispatchWhenIotReady: vi.fn() };
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

    expect(commands).toHaveLength(3);
    expect(
      commands.filter((command) => command.commandType === "START_CHARGING"),
    ).toHaveLength(1);
    expect(
      commands.filter((command) => command.commandType === "STOP_CHARGING"),
    ).toHaveLength(2);
    const activeStop = commands.find(
      (command) =>
        command.commandType === "STOP_CHARGING" &&
        command.status === DeviceCommandStatus.PENDING,
    );
    expect(activeStop).toBeDefined();
    expect(session.status).toBe(ChargingSessionStatus.STOPPING);
    expect(dispatcher.dispatchWhenIotReady).toHaveBeenCalledTimes(2);
    expect(dispatcher.dispatchWhenIotReady).toHaveBeenNthCalledWith(
      1,
      activeStop?.commandId,
    );
    expect(dispatcher.dispatchWhenIotReady).toHaveBeenNthCalledWith(
      2,
      activeStop?.commandId,
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

  it("retries a failed STOPPING command while retaining its history and reason", async () => {
    const fixture = await createFixture(
      ChargingSessionStatus.STOPPING,
      ConnectorStatus.OCCUPIED,
      DeviceCommandStatus.SENT,
    );
    const failedStop = await dataSource.getRepository(DeviceCommand).save({
      id: randomUUID(),
      commandId: randomUUID(),
      session: fixture.session,
      commandType: "STOP_CHARGING",
      payload: {
        sessionId: fixture.session.id,
        reason: "SYSTEM_REQUESTED",
      },
      retryCount: 1,
      nextAttemptAt: null,
      status: DeviceCommandStatus.FAILED,
      acknowledgedAt: null,
    });
    const dispatcher = { dispatchWhenIotReady: vi.fn() };
    const service = new ChargingService(
      dataSource,
      dispatcher as unknown as CommandDispatcherService,
    );

    await expect(service.stopSession(fixture.session.id)).resolves.toEqual({
      accepted: true,
    });

    const commands = await dataSource.getRepository(DeviceCommand).find({
      where: { session: { id: fixture.session.id } },
      order: { createdAt: "ASC" },
    });
    const session = await dataSource
      .getRepository(ChargingSession)
      .findOneByOrFail({ id: fixture.session.id });
    const stopCommands = commands.filter(
      (command) => command.commandType === "STOP_CHARGING",
    );
    const retriedStop = stopCommands.find(
      (command) =>
        command.commandId !== failedStop.commandId &&
        command.status === DeviceCommandStatus.PENDING,
    );

    expect(stopCommands).toHaveLength(2);
    expect(
      stopCommands.find(
        (command) => command.commandId === failedStop.commandId,
      ),
    ).toMatchObject({
      status: DeviceCommandStatus.FAILED,
      payload: {
        sessionId: fixture.session.id,
        reason: "SYSTEM_REQUESTED",
      },
    });
    expect(retriedStop).toMatchObject({
      status: DeviceCommandStatus.PENDING,
      payload: {
        sessionId: fixture.session.id,
        reason: "SYSTEM_REQUESTED",
      },
    });
    expect(session.status).toBe(ChargingSessionStatus.STOPPING);

    await expect(
      dataSource.getRepository(DeviceCommand).save({
        id: randomUUID(),
        commandId: randomUUID(),
        session,
        commandType: "STOP_CHARGING",
        payload: {
          sessionId: session.id,
          reason: "SYSTEM_REQUESTED",
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
