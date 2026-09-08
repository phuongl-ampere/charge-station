import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import type {
  DeviceEvent,
  StartChargingCommand,
} from "@charge-station/contracts";
import { ValidationPipe } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { getDataSourceToken, getRepositoryToken } from "@nestjs/typeorm";
import { DataType, newDb } from "pg-mem";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataSource } from "typeorm";

import { AppModule as IotAppModule } from "../../iot-service/src/app.module.js";
import { DeviceStateService } from "../../iot-service/src/devices/device-state.service.js";
import { ChargeStationEventClient } from "../../iot-service/src/events/charge-station-event.client.js";
import { AuthService } from "../src/auth/auth.service.js";
import { ChargingController } from "../src/charging/charging.controller.js";
import { ChargingService } from "../src/charging/charging.service.js";
import {
  ChargingSession,
  ChargingSessionStatus,
  Connector,
  ConnectorStatus,
  DeviceCommand,
  DeviceEvent,
  entities,
  migrations,
  Order,
  PricingPlan,
  Station,
} from "../src/database/data-source.js";
import { ConnectorsController } from "../src/connectors/connectors.controller.js";
import { ConnectorsService } from "../src/connectors/connectors.service.js";
import { HealthController } from "../src/health.controller.js";
import { CommandDispatcherService } from "../src/iot/command-dispatcher.service.js";
import {
  DeviceEventsController,
  ServiceTokenGuard,
} from "../src/iot/device-events.controller.js";
import { DeviceEventsService } from "../src/iot/device-events.service.js";
import { IotServiceClient } from "../src/iot/iot-service.client.js";
import { configureHttpApp } from "../src/http-app.js";
import { OrdersController } from "../src/orders/orders.controller.js";
import { OrdersService } from "../src/orders/orders.service.js";
import {
  PayosClient,
  type PayosWebhookData,
} from "../src/payments/payos.client.js";
import { PaymentsController } from "../src/payments/payments.controller.js";
import { PaymentsService } from "../src/payments/payments.service.js";
import { ChargeGateway } from "../src/realtime/charge.gateway.js";

class RecordedMockPayosClient extends PayosClient {
  readonly paymentLinkRequests: Array<
    Parameters<PayosClient["createPaymentLink"]>[0]
  > = [];

  override async createPaymentLink(
    input: Parameters<PayosClient["createPaymentLink"]>[0],
  ) {
    this.paymentLinkRequests.push({ ...input });
    return super.createPaymentLink(input);
  }
}

class ShortLifecycleDeviceStateService extends DeviceStateService {
  readonly startTimerCommands: StartChargingCommand[] = [];

  override add(command: StartChargingCommand, deviceId: string) {
    this.startTimerCommands.push(command);
    return super.add({ ...command, durationSeconds: 1 }, deviceId);
  }
}

describe("mock payment-to-charging lifecycle", () => {
  let api: INestApplication;
  let iot: INestApplication;
  let dataSource: DataSource;
  let payosClient: RecordedMockPayosClient;
  let deviceState: ShortLifecycleDeviceStateService;
  let initialDeliveryEvents: Map<"COMMAND_ACCEPTED" | "RUNNING", DeviceEvent[]>;
  let stoppedDeliveryEventIds: string[];
  let apiBaseUrl: string;
  const environment = new Map<string, string | undefined>();
  const testEnvironment = {
    CHARGE_STATION_API_URL: "",
    FRONTEND_URL: "http://localhost:3000",
    IOT_SERVICE_URL: "",
    JWT_SECRET: "charge-lifecycle-test-secret",
    MOCK_IOT_FAILURE_MODE: "none",
    MOCK_IOT_HEARTBEAT_MS: "100",
    MOCK_IOT_START_DELAY_MS: "5",
    PAYOS_API_KEY: "test-api-key",
    PAYOS_CHECKSUM_KEY: "charge-lifecycle-checksum-key",
    PAYOS_CLIENT_ID: "test-client-id",
    PAYOS_MODE: "mock",
    SERVICE_TOKEN: "charge-lifecycle-service-token",
  };

  beforeAll(async () => {
    for (const [name, value] of Object.entries(testEnvironment)) {
      environment.set(name, process.env[name]);
      process.env[name] = value;
    }

    const database = newDb({ autoCreateForeignKeyIndices: true });
    database.public.registerFunction({
      name: "version",
      returns: DataType.text,
      implementation: () => "PostgreSQL 16.0",
    });
    database.public.registerFunction({
      name: "current_database",
      returns: DataType.text,
      implementation: () => "charge_station_test",
    });
    dataSource = database.adapters.createTypeormDataSource({
      type: "postgres",
      entities,
      migrations,
      migrationsRun: false,
    }) as DataSource;
    await dataSource.initialize();
    await dataSource.runMigrations();

    const station = await dataSource.getRepository(Station).save({
      id: randomUUID(),
      code: "ST01",
      name: "Lifecycle Test Station",
      deviceId: "dev_ST01",
    });
    const pricingPlan = await dataSource.getRepository(PricingPlan).save({
      id: randomUUID(),
      name: "Lifecycle Test Pricing",
      hourlyPriceVnd: 5000,
      allowedDurationsMinutes: [60],
    });
    await dataSource.getRepository(Connector).save({
      id: randomUUID(),
      code: "ST01-C01",
      status: ConnectorStatus.AVAILABLE,
      station,
      pricingPlan,
    });

    payosClient = new RecordedMockPayosClient();
    const apiModule = await Test.createTestingModule({
      controllers: [
        ChargingController,
        ConnectorsController,
        DeviceEventsController,
        HealthController,
        OrdersController,
        PaymentsController,
      ],
      providers: [
        ChargingService,
        ChargeGateway,
        {
          provide: CommandDispatcherService,
          useFactory: () =>
            new CommandDispatcherService(dataSource, new IotServiceClient()),
        },
        ConnectorsService,
        DeviceEventsService,
        OrdersService,
        PaymentsService,
        ServiceTokenGuard,
        {
          provide: AuthService,
          useValue: {
            verifyToken: () => {
              throw new Error("User authentication is not used by this test");
            },
          },
        },
        { provide: PayosClient, useValue: payosClient },
        { provide: getDataSourceToken(), useValue: dataSource },
        {
          provide: getRepositoryToken(Connector),
          useValue: dataSource.getRepository(Connector),
        },
      ],
    }).compile();
    api = apiModule.createNestApplication();
    configureHttpApp(api);
    await api.listen(0, "127.0.0.1");
    apiBaseUrl = localUrl(api);
    process.env.CHARGE_STATION_API_URL = apiBaseUrl;

    deviceState = new ShortLifecycleDeviceStateService();
    initialDeliveryEvents = new Map();
    stoppedDeliveryEventIds = [];
    const eventClient = new ChargeStationEventClient();
    const iotModule = await Test.createTestingModule({
      imports: [IotAppModule],
    })
      .overrideProvider(DeviceStateService)
      .useValue(deviceState)
      .overrideProvider(ChargeStationEventClient)
      .useValue({
        post: async (event: DeviceEvent) => {
          if (event.type === "COMMAND_ACCEPTED" || event.type === "RUNNING") {
            const deliveries = initialDeliveryEvents.get(event.type) ?? [];
            deliveries.push(event);
            initialDeliveryEvents.set(event.type, deliveries);
            if (deliveries.length === 1) {
              throw new Error(`simulated lost ${event.type} callback`);
            }
          }
          if (event.type === "STOPPED") {
            stoppedDeliveryEventIds.push(event.eventId);
            if (stoppedDeliveryEventIds.length === 1) {
              throw new Error("simulated lost STOPPED callback");
            }
          }
          await eventClient.post(event);
        },
      })
      .compile();
    iot = iotModule.createNestApplication();
    iot.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await iot.listen(0, "127.0.0.1");
    process.env.IOT_SERVICE_URL = localUrl(iot);
  });

  afterAll(async () => {
    await iot?.close();
    await api?.close();
    await dataSource?.destroy();
    for (const [name, value] of environment) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it("retries lost initial callbacks, reaches CHARGING, and accepts a stop request", async () => {
    await request(api.getHttpServer())
      .get("/health")
      .expect(200)
      .expect({ status: "ok" });
    await request(iot.getHttpServer())
      .get("/health")
      .expect(200)
      .expect({ status: "ok" });
    await request(api.getHttpServer())
      .options("/public/connectors/ST01-C01")
      .set("origin", "http://localhost:3000")
      .set("access-control-request-method", "GET")
      .expect("access-control-allow-origin", "http://localhost:3000")
      .expect(204);

    const connector = await request(api.getHttpServer())
      .get("/public/connectors/ST01-C01")
      .expect(200);
    expect(connector.body).toMatchObject({
      connectorCode: "ST01-C01",
      status: ConnectorStatus.AVAILABLE,
    });

    const created = await request(api.getHttpServer())
      .post("/orders")
      .send({ connectorCode: "ST01-C01", durationMinutes: 60 })
      .expect(201);
    const accessToken = created.body.realtimeAccessToken as string;
    expect(payosClient.paymentLinkRequests).toHaveLength(1);
    expect(payosClient.paymentLinkRequests[0]).toMatchObject({ amount: 5000 });
    expect(deviceState.startTimerCommands).toHaveLength(0);
    expect(await dataSource.getRepository(DeviceCommand).count()).toBe(0);

    const order = await dataSource
      .getRepository(Order)
      .findOneByOrFail({ id: created.body.orderId });
    const webhookData: PayosWebhookData = {
      orderCode: Number(order.payosOrderCode),
      amount: order.amountVnd,
      paymentLinkId: `mock_${order.payosOrderCode}`,
      status: "PAID",
    };
    const webhook = {
      code: "00",
      success: true,
      data: webhookData,
      signature: payosClient.signWebhook(webhookData),
    };

    await request(api.getHttpServer())
      .post("/payments/payos/webhook")
      .send(webhook)
      .expect(201);
    await request(api.getHttpServer())
      .post("/payments/payos/webhook")
      .send(webhook)
      .expect(201);

    await eventually(
      () => Promise.resolve(deviceState.startTimerCommands.length),
      (count) => count === 1,
    );
    expect(deviceState.startTimerCommands).toHaveLength(1);
    expect(await dataSource.getRepository(DeviceCommand).count()).toBe(1);

    const runningSession = await eventually(
      () => readSession(api, created.body.orderId, accessToken),
      (session) => session.status === ChargingSessionStatus.CHARGING,
    );
    expect(runningSession.timerAuthority).toBe("DEVICE");
    expect(deviceState.getSession(runningSession.id)?.status).toBe("RUNNING");
    for (const type of ["COMMAND_ACCEPTED", "RUNNING"] as const) {
      const deliveries = initialDeliveryEvents.get(type);
      expect(deliveries).toHaveLength(2);
      expect(deliveries?.[1]).toEqual(deliveries?.[0]);
    }
    await eventually(
      () =>
        dataSource.getRepository(DeviceEvent).countBy({
          eventType: "RUNNING",
        }),
      (count) => count === 1,
    );
    const persistedSession = await dataSource
      .getRepository(ChargingSession)
      .findOneByOrFail({ id: runningSession.id });
    expect(persistedSession.expectedEndAt?.valueOf()).toBeGreaterThan(
      Date.now() + 50 * 60_000,
    );

    await request(api.getHttpServer())
      .post(`/sessions/${runningSession.id}/stop`)
      .set("authorization", `Bearer ${accessToken}`)
      .expect(202)
      .expect({ accepted: true });

    const stoppedSession = await eventually(
      () => readSession(api, created.body.orderId, accessToken),
      (session) => session.status === ChargingSessionStatus.CANCELLED,
      3_000,
    );
    expect(stoppedSession.status).toBe(ChargingSessionStatus.CANCELLED);
    expect(stoppedDeliveryEventIds).toHaveLength(2);
    expect(stoppedDeliveryEventIds[1]).toBe(stoppedDeliveryEventIds[0]);
    expect(
      deviceState.getCommand(deviceState.startTimerCommands[0].commandId)
        ?.status,
    ).toBe("STOPPED");
    await eventually(
      () =>
        dataSource.getRepository(DeviceEvent).countBy({
          eventType: "STOPPED",
        }),
      (count) => count === 1,
    );
    expect(
      (
        await dataSource.getRepository(Connector).findOneByOrFail({
          code: "ST01-C01",
        })
      ).status,
    ).toBe(ConnectorStatus.AVAILABLE);
  });
});

async function readSession(
  api: INestApplication,
  orderId: string,
  accessToken: string,
): Promise<{
  id: string;
  status: ChargingSessionStatus;
  timerAuthority: "DEVICE";
}> {
  const order = await request(api.getHttpServer())
    .get(`/orders/${orderId}`)
    .set("authorization", `Bearer ${accessToken}`)
    .expect(200);
  return request(api.getHttpServer())
    .get(`/sessions/${order.body.sessionId as string}`)
    .set("authorization", `Bearer ${accessToken}`)
    .expect(200)
    .then((response) => response.body);
}

async function eventually<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  timeoutMs = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!matches(value)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for lifecycle state: ${JSON.stringify(value)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    value = await read();
  }
  return value;
}

function localUrl(app: INestApplication): string {
  const address = app.getHttpServer().address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
