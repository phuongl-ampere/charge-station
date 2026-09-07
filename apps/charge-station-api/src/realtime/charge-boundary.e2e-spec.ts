import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import { UnauthorizedException, ValidationPipe } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { getDataSourceToken } from "@nestjs/typeorm";
import { io, type Socket } from "socket.io-client";
import { DataType, newDb } from "pg-mem";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DataSource } from "typeorm";

import { AuthService } from "../auth/auth.service.js";
import { ChargingController } from "../charging/charging.controller.js";
import { ChargingService } from "../charging/charging.service.js";
import {
  Connector,
  ConnectorStatus,
  DeviceCommand,
  entities,
  migrations,
  Order,
  PricingPlan,
  Station,
} from "../database/data-source.js";
import { CommandDispatcherService } from "../iot/command-dispatcher.service.js";
import { OrdersController } from "../orders/orders.controller.js";
import { OrdersService } from "../orders/orders.service.js";
import {
  PayosClient,
  type PayosWebhookData,
} from "../payments/payos.client.js";
import { PaymentsController } from "../payments/payments.controller.js";
import { PaymentsService } from "../payments/payments.service.js";
import { ChargeGateway } from "./charge.gateway.js";

describe("charge capability boundary", () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let gateway: ChargeGateway;
  let payosClient: PayosClient;
  const previousJwtSecret = process.env.JWT_SECRET;

  beforeAll(async () => {
    process.env.JWT_SECRET = "charge-boundary-test-secret";
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
      name: "Demo Station",
      deviceId: "dev_ST01",
    });
    const pricingPlan = await dataSource.getRepository(PricingPlan).save({
      id: randomUUID(),
      name: "MVP hourly pricing",
      hourlyPriceVnd: 5000,
      allowedDurationsMinutes: [60, 120, 180],
    });
    await dataSource.getRepository(Connector).save({
      id: randomUUID(),
      code: "ST01-C01",
      status: ConnectorStatus.AVAILABLE,
      station,
      pricingPlan,
    });
    await dataSource.getRepository(Connector).save({
      id: randomUUID(),
      code: "ST01-C02",
      status: ConnectorStatus.AVAILABLE,
      station,
      pricingPlan,
    });

    payosClient = new PayosClient({
      mode: "mock",
      clientId: "client-id",
      apiKey: "api-key",
      checksumKey: "checksum-key",
      returnUrl: "http://localhost:5173/charge/return",
      cancelUrl: "http://localhost:5173/charge/cancel",
    });
    const module = await Test.createTestingModule({
      controllers: [PaymentsController, OrdersController, ChargingController],
      providers: [
        PaymentsService,
        OrdersService,
        ChargingService,
        ChargeGateway,
        { provide: PayosClient, useValue: payosClient },
        {
          provide: CommandDispatcherService,
          useValue: { dispatch: vi.fn().mockResolvedValue(undefined) },
        },
        {
          provide: AuthService,
          useValue: {
            verifyToken: vi.fn(() => {
              throw new UnauthorizedException("Invalid token");
            }),
          },
        },
        { provide: getDataSourceToken(), useValue: dataSource },
      ],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.listen(0);
    gateway = app.get(ChargeGateway);
  });

  afterAll(async () => {
    await app.close();
    await dataSource.destroy();
    if (previousJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = previousJwtSecret;
    }
  });

  it("completes payment, authorizes session access and stop, and rejoins both rooms after reconnect", async () => {
    const created = await request(app.getHttpServer())
      .post("/orders")
      .send({ connectorCode: "ST01-C01", durationMinutes: 180 })
      .expect(201);
    const accessToken = created.body.realtimeAccessToken as string;
    expect(accessToken).toEqual(expect.any(String));
    const otherCreated = await request(app.getHttpServer())
      .post("/orders")
      .send({ connectorCode: "ST01-C02", durationMinutes: 60 })
      .expect(201);
    const otherAccessToken = otherCreated.body.realtimeAccessToken as string;

    const order = await dataSource.getRepository(Order).findOneByOrFail({
      id: created.body.orderId,
    });
    const data: PayosWebhookData = {
      orderCode: Number(order.payosOrderCode),
      amount: order.amountVnd,
      paymentLinkId: `mock_${order.payosOrderCode}`,
      status: "PAID",
    };
    await request(app.getHttpServer())
      .post("/payments/payos/webhook")
      .send({
        code: "00",
        success: true,
        data,
        signature: payosClient.signWebhook(data),
      })
      .expect(201);

    const missingTokenStatus = await request(app.getHttpServer())
      .get(`/orders/${order.id}`)
      .expect(401);
    expect(missingTokenStatus.body).not.toHaveProperty("sessionId");
    const invalidTokenStatus = await request(app.getHttpServer())
      .get(`/orders/${order.id}`)
      .set("authorization", "Bearer not-a-capability")
      .expect(401);
    expect(invalidTokenStatus.body).not.toHaveProperty("sessionId");
    const otherOrderTokenStatus = await request(app.getHttpServer())
      .get(`/orders/${order.id}`)
      .set("authorization", `Bearer ${otherAccessToken}`)
      .expect(403);
    expect(otherOrderTokenStatus.body).not.toHaveProperty("sessionId");
    const orderStatus = await request(app.getHttpServer())
      .get(`/orders/${order.id}`)
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    const sessionId = orderStatus.body.sessionId as string;
    expect(sessionId).toEqual(expect.any(String));

    await request(app.getHttpServer())
      .get(`/sessions/${sessionId}`)
      .expect(401);
    const sessionStatus = await request(app.getHttpServer())
      .get(`/sessions/${sessionId}`)
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(sessionStatus.body).toMatchObject({
      id: sessionId,
      orderId: order.id,
    });

    await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/stop`)
      .set("authorization", `Bearer ${accessToken}`)
      .expect(202)
      .expect({ accepted: true });
    expect(
      await dataSource
        .getRepository(DeviceCommand)
        .countBy({ session: { id: sessionId } }),
    ).toBe(2);

    const address = app.getHttpServer().address() as AddressInfo;
    const socket = io(`http://127.0.0.1:${address.port}`, {
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      transports: ["websocket"],
    });
    const subscriptions = [
      { orderId: order.id, accessToken },
      { sessionId, accessToken },
    ];

    try {
      await expect(connectAndSubscribe(socket, subscriptions)).resolves.toEqual(
        [`order:${order.id}`, `session:${sessionId}`],
      );

      socket.disconnect();
      await expect(connectAndSubscribe(socket, subscriptions)).resolves.toEqual(
        [`order:${order.id}`, `session:${sessionId}`],
      );

      const paymentUpdated = waitForSocketEvent(socket, "payment.updated");
      const sessionUpdated = waitForSocketEvent(socket, "session.updated");
      gateway.publishOrder(order.id, "payment.updated", {
        orderId: order.id,
        status: "PAID",
        sessionId,
      });
      gateway.publishSession(sessionId, "session.updated", "STARTING");

      await expect(paymentUpdated).resolves.toMatchObject({ sessionId });
      await expect(sessionUpdated).resolves.toBe("STARTING");
    } finally {
      socket.disconnect();
    }
  });
});

function connectAndSubscribe(
  socket: Socket,
  subscriptions: Array<{
    orderId?: string;
    sessionId?: string;
    accessToken: string;
  }>,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Socket connection or subscription timed out"));
    }, 2_000);
    const fail = (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    };

    socket.once("connect_error", fail);
    socket.once("connect", () => {
      void Promise.all(
        subscriptions.map(
          (payload) =>
            new Promise<string>((resolveSubscription, rejectSubscription) => {
              socket
                .timeout(1_000)
                .emit(
                  "subscribe",
                  payload,
                  (
                    error: Error | null,
                    result: { subscribed?: unknown } | undefined,
                  ) => {
                    if (error) {
                      rejectSubscription(error);
                    } else if (typeof result?.subscribed === "string") {
                      resolveSubscription(result.subscribed);
                    } else {
                      rejectSubscription(
                        new Error("Socket subscription failed"),
                      );
                    }
                  },
                );
            }),
        ),
      ).then((rooms) => {
        clearTimeout(timeout);
        socket.off("connect_error", fail);
        resolve(rooms);
      }, fail);
    });
    socket.connect();
  });
}

function waitForSocketEvent(socket: Socket, event: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${event}`));
    }, 2_000);
    socket.once(event, (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}
