import { randomUUID } from "node:crypto";

import { Logger } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DataSource } from "typeorm";

import {
  ChargingSession,
  Connector,
  ConnectorStatus,
  DeviceCommand,
  DeviceAvailability,
  entities,
  ManagedDevice,
  migrations,
  Order,
  OrderStatus,
  PaymentTransaction,
  PaymentTransactionStatus,
  PricingPlan,
  Station,
} from "../database/data-source.js";
import {
  PayosClient,
  PayosPaymentLinkAmbiguousError,
  PayosPaymentLinkDefinitiveError,
  type PayosWebhookData,
} from "./payos.client.js";
import { PaymentsService } from "./payments.service.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://charge:charge@localhost:5432/charge_station";
const schema = `task4_payments_${randomUUID().replaceAll("-", "")}`;

describe("PayOS payment concurrency with local PostgreSQL", () => {
  let adminDataSource: DataSource;
  let dataSource: DataSource;
  let paymentsService: PaymentsService;
  let payosClient: PayosClient;
  let createdOrderId: string;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
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

    const station = await dataSource.getRepository(Station).save({
      id: randomUUID(),
      code: "ST01",
      name: "PostgreSQL Test Station",
      deviceId: "dev_ST01",
    });
    await dataSource.getRepository(ManagedDevice).save({
      deviceId: station.deviceId!,
      availability: DeviceAvailability.AVAILABLE,
    });
    const pricingPlan = await dataSource.getRepository(PricingPlan).save({
      id: randomUUID(),
      name: "PostgreSQL Test Pricing",
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
    await dataSource.getRepository(Connector).save({
      id: randomUUID(),
      code: "ST01-C03",
      status: ConnectorStatus.AVAILABLE,
      station,
      pricingPlan,
    });
    await dataSource.getRepository(Connector).save({
      id: randomUUID(),
      code: "ST01-C04",
      status: ConnectorStatus.AVAILABLE,
      station,
      pricingPlan,
    });
    await dataSource.getRepository(Connector).save({
      id: randomUUID(),
      code: "ST01-C05",
      status: ConnectorStatus.AVAILABLE,
      station,
      pricingPlan,
    });
    await dataSource.getRepository(Connector).save({
      id: randomUUID(),
      code: "ST01-C06",
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
    paymentsService = new PaymentsService(dataSource, payosClient);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    if (adminDataSource?.isInitialized) {
      await adminDataSource.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await adminDataSource.destroy();
    }
  });

  it("compensates a rejected provider link and allows the connector to be ordered again", async () => {
    const createPaymentLink = vi
      .spyOn(payosClient, "createPaymentLink")
      .mockRejectedValueOnce(
        new PayosPaymentLinkDefinitiveError("PayOS provider rejected"),
      );

    await expect(
      paymentsService.createOrder({
        connectorCode: "ST01-C02",
        durationMinutes: 60,
      }),
    ).rejects.toThrow("PayOS provider rejected");

    const failedPayment = await dataSource
      .getRepository(PaymentTransaction)
      .findOneOrFail({
        where: { order: { connector: { code: "ST01-C02" } } },
        relations: { order: { connector: true } },
      });

    expect(failedPayment.status).toBe(PaymentTransactionStatus.FAILED);
    expect(failedPayment.checkoutUrl).toBeNull();
    expect(failedPayment.order.status).toBe(OrderStatus.PAYMENT_FAILED);
    expect(failedPayment.order.connector.status).toBe(
      ConnectorStatus.AVAILABLE,
    );

    await expect(
      paymentsService.createOrder({
        connectorCode: "ST01-C02",
        durationMinutes: 60,
      }),
    ).resolves.toMatchObject({
      payment: {
        provider: "PAYOS",
        checkoutUrl: expect.any(String),
      },
    });
    expect(createPaymentLink).toHaveBeenCalledTimes(2);
  });

  it("keeps an ambiguous provider outcome pending so a signed PAID webhook creates a session", async () => {
    const createPaymentLink = vi
      .spyOn(payosClient, "createPaymentLink")
      .mockRejectedValue(
        new PayosPaymentLinkAmbiguousError("PayOS payment creation timed out"),
      );
    const getPaymentLinkInfo = vi
      .spyOn(payosClient, "getPaymentLinkInfo")
      .mockRejectedValue(
        new PayosPaymentLinkAmbiguousError("PayOS lookup is unavailable"),
      );

    try {
      const created = await paymentsService.createOrder({
        connectorCode: "ST01-C03",
        durationMinutes: 60,
      });
      expect(created.payment).toEqual({
        provider: "PAYOS",
        paymentPending: true,
      });
      expect(createPaymentLink).toHaveBeenCalledTimes(1);

      const payment = await dataSource
        .getRepository(PaymentTransaction)
        .findOneOrFail({
          where: { order: { id: created.orderId } },
          relations: { order: { connector: true } },
        });
      expect(payment).toMatchObject({
        status: PaymentTransactionStatus.PENDING,
        checkoutUrl: null,
      });
      expect(payment.order.status).toBe(OrderStatus.PENDING_PAYMENT);
      expect(payment.order.connector.status).toBe(ConnectorStatus.OCCUPIED);

      const data: PayosWebhookData = {
        orderCode: Number(payment.order.payosOrderCode),
        amount: payment.order.amountVnd,
        paymentLinkId: "payos_" + payment.order.payosOrderCode,
        status: "PAID",
      };
      await paymentsService.handleWebhook({
        code: "00",
        success: true,
        data,
        signature: payosClient.signWebhook(data),
      });

      expect(
        await dataSource
          .getRepository(ChargingSession)
          .countBy({ order: { id: created.orderId } }),
      ).toBe(1);
      expect(
        await dataSource.getRepository(DeviceCommand).count({
          where: { session: { order: { id: created.orderId } } },
        }),
      ).toBe(1);
      expect(
        (
          await dataSource
            .getRepository(PaymentTransaction)
            .findOneByOrFail({ id: payment.id })
        ).status,
      ).toBe(PaymentTransactionStatus.PAID);
    } finally {
      getPaymentLinkInfo.mockRestore();
      createPaymentLink.mockRestore();
    }
  });

  it("allows exactly one concurrent pending order to reserve a connector", async () => {
    const results = await Promise.allSettled([
      paymentsService.createOrder({
        connectorCode: "ST01-C01",
        durationMinutes: 120,
      }),
      paymentsService.createOrder({
        connectorCode: "ST01-C01",
        durationMinutes: 120,
      }),
    ]);

    const successfulResult = results.find(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<PaymentsService["createOrder"]>>
      > => result.status === "fulfilled",
    );

    expect(successfulResult).toBeDefined();
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    createdOrderId = successfulResult!.value.orderId;
    expect(
      await dataSource.getRepository(Order).count({
        where: { connector: { code: "ST01-C01" } },
      }),
    ).toBe(1);
    expect(
      (
        await dataSource
          .getRepository(Connector)
          .findOneByOrFail({ code: "ST01-C01" })
      ).status,
    ).toBe(ConnectorStatus.OCCUPIED);
  });

  it("serializes a reservation behind an in-use device availability update", async () => {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    let reservation: ReturnType<PaymentsService["createOrder"]> | undefined;
    try {
      await runner.query(
        "SELECT device_id FROM managed_devices WHERE device_id = $1 FOR UPDATE",
        ["dev_ST01"],
      );
      await runner.manager.getRepository(ManagedDevice).update(
        { deviceId: "dev_ST01" },
        { availability: DeviceAvailability.IN_USE },
      );

      reservation = paymentsService.createOrder({
        connectorCode: "ST01-C06",
        durationMinutes: 60,
      });
      const beforeAvailabilityCommit = await Promise.race([
        reservation.then(() => "settled", () => "settled"),
        new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 50)),
      ]);
      expect(beforeAvailabilityCommit).toBe("waiting");

      await runner.commitTransaction();
      await expect(reservation).rejects.toThrow("Station device is in use");
    } finally {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }
      await runner.release();
      await dataSource.getRepository(ManagedDevice).update(
        { deviceId: "dev_ST01" },
        { availability: DeviceAvailability.AVAILABLE },
      );
    }
  });

  it("expires one overdue reservation across concurrent PostgreSQL reaper passes", async () => {
    const created = await paymentsService.createOrder({
      connectorCode: "ST01-C04",
      durationMinutes: 60,
    });
    const payment = await dataSource
      .getRepository(PaymentTransaction)
      .findOneOrFail({
        where: { order: { id: created.orderId } },
        relations: { order: { connector: true } },
      });
    const now = new Date();
    await dataSource.getRepository(PaymentTransaction).update(payment.id, {
      expiresAt: new Date(now.valueOf() - 1),
    });

    const results = await Promise.all([
      paymentsService.expireDueReservations(now),
      paymentsService.expireDueReservations(now),
    ]);

    expect(results.reduce((total, count) => total + count, 0)).toBe(1);
    const expired = await dataSource
      .getRepository(PaymentTransaction)
      .findOneOrFail({
        where: { id: payment.id },
        relations: { order: { connector: true } },
      });
    expect(expired.status).toBe(PaymentTransactionStatus.EXPIRED);
    expect(expired.order.status).toBe(OrderStatus.EXPIRED);
    expect(expired.order.connector.status).toBe(ConnectorStatus.AVAILABLE);
  });

  it("leaves a fresh persisted checkout pending during a reaper pass", async () => {
    const created = await paymentsService.createOrder({
      connectorCode: "ST01-C05",
      durationMinutes: 60,
    });
    const payment = await dataSource
      .getRepository(PaymentTransaction)
      .findOneOrFail({
        where: { order: { id: created.orderId } },
        relations: { order: { connector: true } },
      });

    await paymentsService.expireDueReservations(new Date());

    const persisted = await dataSource
      .getRepository(PaymentTransaction)
      .findOneOrFail({
        where: { id: payment.id },
        relations: { order: { connector: true } },
      });
    expect(persisted.status).toBe(PaymentTransactionStatus.PENDING);
    expect(persisted.checkoutUrl).toEqual(expect.any(String));
    expect(persisted.expiresAt.valueOf()).toBeGreaterThan(Date.now());
    expect(persisted.order.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(persisted.order.connector.status).toBe(ConnectorStatus.OCCUPIED);
  });

  it("creates one charging session and command for concurrent duplicate paid webhooks", async () => {
    const order = await dataSource
      .getRepository(Order)
      .findOneByOrFail({ id: createdOrderId });
    const data: PayosWebhookData = {
      orderCode: Number(order.payosOrderCode),
      amount: order.amountVnd,
      paymentLinkId: `mock_${order.payosOrderCode}`,
      status: "PAID",
    };
    const body = {
      code: "00",
      success: true,
      data,
      signature: payosClient.signWebhook(data),
    };

    await Promise.all([
      paymentsService.handleWebhook(body),
      paymentsService.handleWebhook(body),
    ]);

    expect(
      await dataSource.getRepository(PaymentTransaction).count({
        where: { order: { id: order.id } },
      }),
    ).toBe(1);
    expect(
      await dataSource
        .getRepository(ChargingSession)
        .countBy({ order: { id: order.id } }),
    ).toBe(1);
    expect(
      await dataSource.getRepository(DeviceCommand).count({
        where: { session: { order: { id: order.id } } },
      }),
    ).toBe(1);
  });
});
