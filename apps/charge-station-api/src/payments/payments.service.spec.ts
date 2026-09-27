import { randomUUID } from "node:crypto";

import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { DataSource } from "typeorm";

import {
  ChargingSession,
  ChargingSessionStatus,
  Connector,
  DeviceCommand,
  Order,
  OrderStatus,
  PaymentTransaction,
  PaymentTransactionStatus,
} from "../database/data-source.js";
import type { CommandDispatcherService } from "../iot/command-dispatcher.service.js";
import type { ChargeGateway } from "../realtime/charge.gateway.js";
import type { PayosClient } from "./payos.client.js";
import type { PayosWebhook } from "./payos.client.js";
import { PaymentsService } from "./payments.service.js";

describe("PaymentsService webhook processing", () => {
  it("rejects a new order when the linked device telemetry is stale", async () => {
    const connector = {
      id: randomUUID(),
      code: "ST01-C01",
      status: "AVAILABLE",
      station: { deviceId: "core-device-1" },
      pricingPlan: { hourlyPriceVnd: 5000, allowedDurationsMinutes: [60] },
    } as Connector;
    const manager = {
      query: vi
        .fn()
        .mockResolvedValueOnce([{ id: connector.id }])
        .mockResolvedValueOnce([{ availability: "AVAILABLE" }]),
      getRepository: vi.fn((entity) => {
        if (entity === Connector) return { findOne: vi.fn().mockResolvedValue(connector) };
        if (entity === Order || entity === PaymentTransaction) return {};
        throw new Error("Unexpected repository");
      }),
    };
    const transaction = vi.fn(async (callback) => callback(manager));
    const core = {
      latestTelemetry: vi.fn().mockResolvedValue({
        eventAt: "2000-01-01T00:00:00.000Z",
      }),
    };
    const service = new PaymentsService(
      {
        transaction,
        getRepository: () => ({ findOne: vi.fn().mockResolvedValue(connector) }),
      } as unknown as DataSource,
      {} as PayosClient,
      undefined,
      undefined,
      core as never,
    );

    await expect(
      service.createOrder({ connectorCode: connector.code, durationMinutes: 60 }),
    ).rejects.toThrow("Station device is unavailable");
    expect(core.latestTelemetry).toHaveBeenCalledWith("core-device-1");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("returns a signed realtime access token after persisting a new order", async () => {
    const connector = {
      id: randomUUID(),
      code: "ST01-C01",
      status: "AVAILABLE",
      pricingPlan: {
        hourlyPriceVnd: 5000,
        allowedDurationsMinutes: [60, 120],
      },
    } as Connector;
    const orderRepository = {
      create: vi.fn().mockImplementation((entity) => ({
        ...entity,
        payosOrderCode: "100001",
      })),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const paymentRepository = {
      create: vi.fn().mockImplementation((entity) => entity),
      findOneBy: vi.fn().mockResolvedValue({ checkoutUrl: null }),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const connectorRepository = {
      findOne: vi.fn().mockResolvedValue(connector),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const manager = {
      query: vi.fn().mockResolvedValue([{ id: connector.id }]),
      getRepository: vi.fn((entity) => {
        if (entity === Connector) return connectorRepository;
        if (entity === Order) return orderRepository;
        if (entity === PaymentTransaction) return paymentRepository;
        throw new Error("Unexpected repository");
      }),
    };
    const dataSource = {
      transaction: vi.fn(async (callback) => callback(manager)),
    };
    const gateway = {
      issueAccessToken: vi.fn().mockReturnValue("signed-realtime-token"),
    };
    const client = {
      returnUrl: "http://localhost:5173/charge/return",
      cancelUrl: "http://localhost:5173/charge/cancel",
      createPaymentLink: vi.fn().mockResolvedValue({
        paymentLinkId: "pl_123",
        checkoutUrl: "http://localhost:4000/mock-checkout",
      }),
    };
    const service = new PaymentsService(
      dataSource as unknown as DataSource,
      client as unknown as PayosClient,
      undefined,
      gateway as unknown as ChargeGateway,
    );

    await expect(
      service.createOrder({
        connectorCode: connector.code,
        durationMinutes: 120,
      }),
    ).resolves.toMatchObject({
      orderId: expect.any(String),
      realtimeAccessToken: "signed-realtime-token",
    });
    expect(gateway.issueAccessToken).toHaveBeenCalledWith(
      orderRepository.create.mock.results[0]?.value.id,
    );
  });

  it("persists a configured payment reservation expiry from the current clock", async () => {
    const previousExpiryMinutes = process.env.PAYMENT_RESERVATION_TTL_MINUTES;
    process.env.PAYMENT_RESERVATION_TTL_MINUTES = "5";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T11:00:00.000Z"));
    const connector = {
      id: randomUUID(),
      code: "ST01-C01",
      status: "AVAILABLE",
      pricingPlan: {
        hourlyPriceVnd: 5000,
        allowedDurationsMinutes: [60],
      },
    } as Connector;
    let savedPayment: PaymentTransaction | undefined;
    const connectorRepository = {
      findOne: vi.fn().mockResolvedValue(connector),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const orderRepository = {
      create: vi.fn().mockImplementation((entity) => ({
        ...entity,
        payosOrderCode: "100001",
      })),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const paymentRepository = {
      create: vi.fn().mockImplementation((entity) => entity),
      findOneBy: vi.fn().mockImplementation(async () => savedPayment),
      save: vi.fn().mockImplementation(async (entity) => {
        savedPayment = entity;
        return entity;
      }),
    };
    const manager = {
      query: vi.fn().mockImplementation(async (query: string) => {
        if (query.includes("FROM connectors")) return [{ id: connector.id }];
        if (query.includes("FROM payment_transactions")) {
          return [{ id: savedPayment?.id }];
        }
        throw new Error("Unexpected lock query");
      }),
      getRepository: vi.fn((entity) => {
        if (entity === Connector) return connectorRepository;
        if (entity === Order) return orderRepository;
        if (entity === PaymentTransaction) return paymentRepository;
        throw new Error("Unexpected repository");
      }),
    };
    const dataSource = {
      transaction: vi.fn(async (callback) => callback(manager)),
    };
    const payosClient = {
      returnUrl: "http://localhost:5173/charge/return",
      cancelUrl: "http://localhost:5173/charge/cancel",
      createPaymentLink: vi.fn().mockResolvedValue({
        paymentLinkId: "pl_100001",
        checkoutUrl: "http://localhost:4000/payments/payos/mock/100001",
      }),
    };
    const service = new PaymentsService(
      dataSource as unknown as DataSource,
      payosClient as unknown as PayosClient,
    );

    try {
      await service.createOrder({
        connectorCode: connector.code,
        durationMinutes: 60,
      });

      expect(
        (savedPayment as PaymentTransaction & { expiresAt?: Date }).expiresAt,
      ).toEqual(new Date("2026-09-08T11:05:00.000Z"));
    } finally {
      vi.useRealTimers();
      if (previousExpiryMinutes === undefined) {
        delete process.env.PAYMENT_RESERVATION_TTL_MINUTES;
      } else {
        process.env.PAYMENT_RESERVATION_TTL_MINUTES = previousExpiryMinutes;
      }
    }
  });

  it("expires a due reservation exactly once and releases its connector", async () => {
    const now = new Date("2026-09-08T11:15:00.000Z");
    const connector = {
      id: randomUUID(),
      code: "ST01-C01",
      status: "OCCUPIED",
    } as Connector;
    const order = {
      id: randomUUID(),
      payosOrderCode: "100001",
      status: OrderStatus.PENDING_PAYMENT,
      connector,
    } as Order;
    const payment = {
      id: randomUUID(),
      order,
      paymentLinkId: "pl_100001",
      checkoutUrl: "https://pay.example/100001",
      status: PaymentTransactionStatus.PENDING,
      expiresAt: new Date("2026-09-08T11:14:59.999Z"),
    } as PaymentTransaction;
    const paymentRepository = {
      find: vi.fn().mockResolvedValue([payment]),
      findOne: vi.fn().mockResolvedValue(payment),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const orderRepository = {
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const connectorRepository = {
      findOne: vi.fn().mockResolvedValue(connector),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const manager = {
      query: vi.fn().mockImplementation(async (query: string) => {
        if (query.includes("FROM payment_transactions")) {
          return [{ id: payment.id }];
        }
        if (query.includes("FROM connectors")) return [{ id: connector.id }];
        throw new Error("Unexpected lock query");
      }),
      getRepository: vi.fn((entity) => {
        if (entity === PaymentTransaction) return paymentRepository;
        if (entity === Order) return orderRepository;
        if (entity === Connector) return connectorRepository;
        throw new Error("Unexpected repository");
      }),
    };
    const dataSource = {
      getRepository: vi.fn((entity) => {
        if (entity === PaymentTransaction) return paymentRepository;
        throw new Error("Unexpected repository");
      }),
      transaction: vi.fn(async (callback) => callback(manager)),
    };
    const payosClient = {
      cancelPaymentLink: vi.fn().mockResolvedValue(undefined),
    };
    const gateway = {
      publishOrder: vi.fn(),
    };
    const service = new PaymentsService(
      dataSource as unknown as DataSource,
      payosClient as unknown as PayosClient,
      undefined,
      gateway as unknown as ChargeGateway,
    );
    const expiryService = service as unknown as {
      expireDueReservations(now: Date): Promise<number>;
    };

    await expect(expiryService.expireDueReservations(now)).resolves.toBe(1);
    expect(payment.status).toBe(PaymentTransactionStatus.EXPIRED);
    expect(order.status).toBe(OrderStatus.EXPIRED);
    expect(connector.status).toBe("AVAILABLE");
    expect(payosClient.cancelPaymentLink).toHaveBeenCalledWith(100001);
    expect(gateway.publishOrder).toHaveBeenCalledWith(
      order.id,
      "payment.updated",
      {
        orderId: order.id,
        status: OrderStatus.EXPIRED,
      },
    );

    await expect(expiryService.expireDueReservations(now)).resolves.toBe(0);
    expect(payosClient.cancelPaymentLink).toHaveBeenCalledOnce();
    expect(gateway.publishOrder).toHaveBeenCalledOnce();
  });

  it("does not restore an expired reservation when initial link creation races the reaper", async () => {
    const connector = {
      id: randomUUID(),
      code: "ST01-C01",
      status: "AVAILABLE",
      pricingPlan: {
        hourlyPriceVnd: 5000,
        allowedDurationsMinutes: [60],
      },
    } as Connector;
    let savedPayment: PaymentTransaction | undefined;
    const connectorRepository = {
      findOne: vi.fn().mockResolvedValue(connector),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const orderRepository = {
      create: vi.fn().mockImplementation((entity) => ({
        ...entity,
        payosOrderCode: "100001",
      })),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const paymentRepository = {
      create: vi.fn().mockImplementation((entity) => entity),
      findOneBy: vi.fn().mockImplementation(async () => savedPayment),
      save: vi.fn().mockImplementation(async (entity) => {
        savedPayment = entity;
        return entity;
      }),
    };
    const manager = {
      query: vi.fn().mockImplementation(async (query: string) => {
        if (query.includes("FROM connectors")) return [{ id: connector.id }];
        if (query.includes("FROM payment_transactions")) {
          return [{ id: savedPayment?.id }];
        }
        throw new Error("Unexpected lock query");
      }),
      getRepository: vi.fn((entity) => {
        if (entity === Connector) return connectorRepository;
        if (entity === Order) return orderRepository;
        if (entity === PaymentTransaction) return paymentRepository;
        throw new Error("Unexpected repository");
      }),
    };
    const dataSource = {
      transaction: vi.fn(async (callback) => callback(manager)),
    };
    const payosClient = {
      returnUrl: "http://localhost:5173/charge/return",
      cancelUrl: "http://localhost:5173/charge/cancel",
      cancelPaymentLink: vi.fn().mockResolvedValue(undefined),
      createPaymentLink: vi.fn().mockImplementation(async () => {
        if (!savedPayment) throw new Error("Payment reservation was not saved");
        savedPayment.status = PaymentTransactionStatus.EXPIRED;
        savedPayment.order.status = OrderStatus.EXPIRED;
        connector.status = "AVAILABLE";
        return {
          paymentLinkId: "pl_100001",
          checkoutUrl: "https://pay.example/100001",
        };
      }),
    };
    const service = new PaymentsService(
      dataSource as unknown as DataSource,
      payosClient as unknown as PayosClient,
    );

    await expect(
      service.createOrder({
        connectorCode: connector.code,
        durationMinutes: 60,
      }),
    ).rejects.toThrow("Payment reservation is no longer pending");

    expect(savedPayment?.status).toBe(PaymentTransactionStatus.EXPIRED);
    expect(savedPayment?.checkoutUrl).toBeNull();
    expect(payosClient.cancelPaymentLink).not.toHaveBeenCalled();
  });

  it("calls PayOS only after connector, order, and payment reservation commits", async () => {
    const connector = {
      id: randomUUID(),
      code: "ST01-C01",
      status: "AVAILABLE",
      pricingPlan: {
        hourlyPriceVnd: 5000,
        allowedDurationsMinutes: [60],
      },
    } as Connector;
    let savedPayment: PaymentTransaction | undefined;
    const connectorRepository = {
      findOne: vi.fn().mockResolvedValue(connector),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const orderRepository = {
      create: vi.fn().mockImplementation((entity) => ({
        ...entity,
        payosOrderCode: "100001",
      })),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const paymentRepository = {
      create: vi.fn().mockImplementation((entity) => entity),
      findOneBy: vi.fn().mockImplementation(async () => savedPayment),
      save: vi.fn().mockImplementation(async (entity) => {
        savedPayment = entity;
        return entity;
      }),
    };
    const manager = {
      query: vi.fn().mockImplementation(async (query: string) => {
        if (query.includes("FROM connectors")) {
          return [{ id: connector.id }];
        }
        if (query.includes("FROM payment_transactions")) {
          return [{ id: savedPayment?.id }];
        }
        throw new Error("Unexpected lock query");
      }),
      getRepository: vi.fn((entity) => {
        if (entity === Connector) return connectorRepository;
        if (entity === Order) return orderRepository;
        if (entity === PaymentTransaction) return paymentRepository;
        throw new Error("Unexpected repository");
      }),
    };
    let transactionActive = false;
    const dataSource = {
      transaction: vi.fn(async (callback) => {
        transactionActive = true;
        try {
          return await callback(manager);
        } finally {
          transactionActive = false;
        }
      }),
    };
    const payosClient = {
      returnUrl: "http://localhost:5173/charge/return",
      cancelUrl: "http://localhost:5173/charge/cancel",
      createPaymentLink: vi.fn(async () => {
        expect(transactionActive).toBe(false);
        return {
          paymentLinkId: "pl_100001",
          checkoutUrl: "https://pay.example/100001",
        };
      }),
    };
    const service = new PaymentsService(
      dataSource as unknown as DataSource,
      payosClient as unknown as PayosClient,
    );

    await expect(
      service.createOrder({
        connectorCode: connector.code,
        durationMinutes: 60,
      }),
    ).resolves.toMatchObject({
      payment: {
        checkoutUrl: "https://pay.example/100001",
      },
    });
    expect(payosClient.createPaymentLink).toHaveBeenCalledOnce();
  });

  it("compensates an invalid PayOS payment-link response", async () => {
    const connector = {
      id: randomUUID(),
      code: "ST01-C01",
      status: "AVAILABLE",
      pricingPlan: {
        hourlyPriceVnd: 5000,
        allowedDurationsMinutes: [60],
      },
    } as Connector;
    let savedOrder: Order | undefined;
    let savedPayment: PaymentTransaction | undefined;
    const connectorRepository = {
      findOne: vi.fn().mockResolvedValue(connector),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const orderRepository = {
      create: vi.fn().mockImplementation((entity) => ({
        ...entity,
        payosOrderCode: "100001",
      })),
      save: vi.fn().mockImplementation(async (entity) => {
        savedOrder = entity;
        return entity;
      }),
    };
    const paymentRepository = {
      create: vi.fn().mockImplementation((entity) => entity),
      findOne: vi.fn().mockImplementation(async () => savedPayment),
      save: vi.fn().mockImplementation(async (entity) => {
        savedPayment = entity;
        return entity;
      }),
    };
    const manager = {
      query: vi.fn().mockImplementation(async (query: string) => {
        if (query.includes("FROM connectors")) {
          return [{ id: connector.id }];
        }
        if (query.includes("FROM payment_transactions")) {
          return [{ id: savedPayment?.id }];
        }
        throw new Error("Unexpected lock query");
      }),
      getRepository: vi.fn((entity) => {
        if (entity === Connector) return connectorRepository;
        if (entity === Order) return orderRepository;
        if (entity === PaymentTransaction) return paymentRepository;
        throw new Error("Unexpected repository");
      }),
    };
    const dataSource = {
      transaction: vi.fn(async (callback) => callback(manager)),
    };
    const payosClient = {
      returnUrl: "http://localhost:5173/charge/return",
      cancelUrl: "http://localhost:5173/charge/cancel",
      createPaymentLink: vi.fn().mockResolvedValue({
        checkoutUrl: "",
        paymentLinkId: "",
      }),
    };
    const service = new PaymentsService(
      dataSource as unknown as DataSource,
      payosClient as unknown as PayosClient,
    );

    await expect(
      service.createOrder({
        connectorCode: connector.code,
        durationMinutes: 60,
      }),
    ).rejects.toThrow("PayOS returned an invalid payment link");

    expect(savedPayment).toMatchObject({
      status: PaymentTransactionStatus.FAILED,
      checkoutUrl: null,
      paymentLinkId: null,
    });
    expect(savedOrder).toMatchObject({
      status: OrderStatus.PAYMENT_FAILED,
    });
    expect(connector.status).toBe("AVAILABLE");
    expect(dataSource.transaction).toHaveBeenCalledTimes(2);
  });

  it("keeps an ambiguous PayOS reservation pending with an order capability", async () => {
    const connector = {
      id: randomUUID(),
      code: "ST01-C01",
      status: "AVAILABLE",
      pricingPlan: {
        hourlyPriceVnd: 5000,
        allowedDurationsMinutes: [60],
      },
    } as Connector;
    let savedOrder: Order | undefined;
    let savedPayment: PaymentTransaction | undefined;
    const connectorRepository = {
      findOne: vi.fn().mockResolvedValue(connector),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const orderRepository = {
      create: vi.fn().mockImplementation((entity) => ({
        ...entity,
        payosOrderCode: "100001",
      })),
      save: vi.fn().mockImplementation(async (entity) => {
        savedOrder = entity;
        return entity;
      }),
    };
    const paymentRepository = {
      create: vi.fn().mockImplementation((entity) => entity),
      findOne: vi.fn().mockImplementation(async () => savedPayment),
      save: vi.fn().mockImplementation(async (entity) => {
        savedPayment = entity;
        return entity;
      }),
    };
    const manager = {
      query: vi.fn().mockImplementation(async (query: string) => {
        if (query.includes("FROM connectors")) {
          return [{ id: connector.id }];
        }
        if (query.includes("FROM payment_transactions")) {
          return [{ id: savedPayment?.id }];
        }
        throw new Error("Unexpected lock query");
      }),
      getRepository: vi.fn((entity) => {
        if (entity === Connector) return connectorRepository;
        if (entity === Order) return orderRepository;
        if (entity === PaymentTransaction) return paymentRepository;
        throw new Error("Unexpected repository");
      }),
    };
    const dataSource = {
      transaction: vi.fn(async (callback) => callback(manager)),
    };
    const payosClient = {
      returnUrl: "http://localhost:5173/charge/return",
      cancelUrl: "http://localhost:5173/charge/cancel",
      createPaymentLink: vi
        .fn()
        .mockRejectedValue(new Error("PayOS request timed out")),
      getPaymentLinkInfo: vi
        .fn()
        .mockRejectedValue(new Error("PayOS lookup is unavailable")),
    };
    const gateway = {
      issueAccessToken: vi.fn().mockReturnValue("signed-realtime-token"),
    };
    const service = new PaymentsService(
      dataSource as unknown as DataSource,
      payosClient as unknown as PayosClient,
      undefined,
      gateway as unknown as ChargeGateway,
    );
    const logger = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);

    try {
      await expect(
        service.createOrder({
          connectorCode: connector.code,
          durationMinutes: 60,
        }),
      ).resolves.toMatchObject({
        payment: { provider: "PAYOS", paymentPending: true },
        realtimeAccessToken: "signed-realtime-token",
      });
    } finally {
      logger.mockRestore();
    }

    expect(savedOrder).toMatchObject({ status: OrderStatus.PENDING_PAYMENT });
    expect(savedPayment).toMatchObject({
      status: PaymentTransactionStatus.PENDING,
      checkoutUrl: null,
      paymentLinkId: null,
    });
    expect(connector.status).toBe("OCCUPIED");
    expect(payosClient.getPaymentLinkInfo).toHaveBeenCalledWith(100001);
    expect(gateway.issueAccessToken).toHaveBeenCalledWith(savedOrder?.id);
  });

  it("reconciles a created PayOS link after its first persistence transaction fails", async () => {
    const connector = {
      id: randomUUID(),
      code: "ST01-C01",
      status: "AVAILABLE",
      pricingPlan: {
        hourlyPriceVnd: 5000,
        allowedDurationsMinutes: [60],
      },
    } as Connector;
    let savedPayment: PaymentTransaction | undefined;
    const connectorRepository = {
      findOne: vi.fn().mockResolvedValue(connector),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const orderRepository = {
      create: vi.fn().mockImplementation((entity) => ({
        ...entity,
        payosOrderCode: "100001",
      })),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const paymentRepository = {
      create: vi.fn().mockImplementation((entity) => entity),
      findOne: vi.fn().mockImplementation(async () => savedPayment),
      findOneBy: vi.fn().mockImplementation(async () => savedPayment),
      save: vi.fn().mockImplementation(async (entity) => {
        savedPayment = entity;
        return entity;
      }),
    };
    const manager = {
      query: vi.fn().mockImplementation(async (query: string) => {
        if (query.includes("FROM connectors")) {
          return [{ id: connector.id }];
        }
        if (query.includes("FROM payment_transactions")) {
          return [{ id: savedPayment?.id }];
        }
        throw new Error("Unexpected lock query");
      }),
      getRepository: vi.fn((entity) => {
        if (entity === Connector) return connectorRepository;
        if (entity === Order) return orderRepository;
        if (entity === PaymentTransaction) return paymentRepository;
        throw new Error("Unexpected repository");
      }),
    };
    let transactionCount = 0;
    const dataSource = {
      getRepository: vi.fn((entity) => {
        if (entity === PaymentTransaction) return paymentRepository;
        throw new Error("Unexpected repository");
      }),
      transaction: vi.fn(async (callback) => {
        transactionCount += 1;
        if (transactionCount === 2) {
          throw new Error("simulated payment-link persistence failure");
        }
        return callback(manager);
      }),
    };
    const paymentLink = {
      paymentLinkId: "pl_100001",
      checkoutUrl: "https://pay.example/100001",
    };
    const payosClient = {
      returnUrl: "http://localhost:5173/charge/return",
      cancelUrl: "http://localhost:5173/charge/cancel",
      createPaymentLink: vi.fn().mockResolvedValue(paymentLink),
      getPaymentLinkInfo: vi.fn().mockResolvedValue(paymentLink),
    };
    const service = new PaymentsService(
      dataSource as unknown as DataSource,
      payosClient as unknown as PayosClient,
    );
    const logger = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);

    try {
      const created = await service.createOrder({
        connectorCode: connector.code,
        durationMinutes: 60,
      });
      expect(created).toMatchObject({
        payment: {
          checkoutUrl: paymentLink.checkoutUrl,
        },
      });
      expect(savedPayment).toMatchObject({
        paymentLinkId: null,
        checkoutUrl: null,
      });
      const recoveryService = service as unknown as {
        getPaymentLink(orderId: string): Promise<{
          provider: "PAYOS";
          checkoutUrl: string;
        }>;
      };

      await expect(
        recoveryService.getPaymentLink(created.orderId),
      ).resolves.toEqual({
        provider: "PAYOS",
        checkoutUrl: paymentLink.checkoutUrl,
      });
    } finally {
      logger.mockRestore();
    }

    expect(payosClient.createPaymentLink).toHaveBeenCalledOnce();
    expect(payosClient.getPaymentLinkInfo).toHaveBeenCalledWith(100001);
    expect(dataSource.transaction).toHaveBeenCalledTimes(3);
    expect(savedPayment).toMatchObject({
      paymentLinkId: paymentLink.paymentLinkId,
      checkoutUrl: paymentLink.checkoutUrl,
    });
  });

  it("queues the paid start command only after the payment transaction commits", async () => {
    const pendingOrder = {
      id: randomUUID(),
      payosOrderCode: "100001",
      amountVnd: 10000,
      durationMinutes: 120,
      status: OrderStatus.PENDING_PAYMENT,
      connector: {
        id: randomUUID(),
        code: "ST01-C01",
        station: { deviceId: "dev_ST01" },
      },
    } as Order;
    const payment = {
      id: randomUUID(),
      status: PaymentTransactionStatus.PENDING,
      order: pendingOrder,
    } as PaymentTransaction;
    const paymentRepository = {
      findOne: vi.fn().mockResolvedValue(payment),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const orderRepository = {
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const connectorRepository = {
      findOne: vi.fn().mockResolvedValue(pendingOrder.connector),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const sessionRepository = {
      create: vi.fn().mockImplementation((entity) => entity),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const commandRepository = {
      create: vi.fn().mockImplementation((entity) => entity),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const manager = {
      query: vi.fn().mockImplementation(async (query: string) => {
        if (query.includes("FROM payment_transactions"))
          return [{ id: payment.id }];
        if (query.includes("FROM connectors"))
          return [{ id: pendingOrder.connector.id }];
        throw new Error("Unexpected lock query");
      }),
      getRepository: vi.fn((entity) => {
        if (entity === PaymentTransaction) return paymentRepository;
        if (entity === Order) return orderRepository;
        if (entity === Connector) return connectorRepository;
        if (entity === ChargingSession) return sessionRepository;
        if (entity === DeviceCommand) return commandRepository;
        throw new Error("Unexpected repository");
      }),
    };
    let transactionCommitted = false;
    const dataSource = {
      transaction: vi.fn(async (callback) => {
        const result = await callback(manager);
        transactionCommitted = true;
        return result;
      }),
    };
    const client = {
      verifyWebhook: vi.fn().mockReturnValue(true),
    };
    const commandDispatcher = {
      dispatchWhenIotReady: vi.fn(() => {
        expect(transactionCommitted).toBe(true);
      }),
    };
    const gateway = {
      publishOrder: vi.fn(() => {
        expect(transactionCommitted).toBe(true);
      }),
      publishSession: vi.fn(() => {
        expect(transactionCommitted).toBe(true);
      }),
    };
    const service = new PaymentsService(
      dataSource as unknown as DataSource,
      client as unknown as PayosClient,
      commandDispatcher as unknown as CommandDispatcherService,
      gateway as unknown as ChargeGateway,
    );
    const body: PayosWebhook = {
      code: "00",
      success: true,
      signature: "valid",
      data: {
        orderCode: 100001,
        amount: 10000,
        paymentLinkId: "pl_123",
        status: "PAID",
      },
    };

    await expect(service.handleWebhook(body)).resolves.toEqual({
      success: true,
    });
    await service.handleWebhook(body);

    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM payment_transactions"),
      ["100001"],
    );
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM connectors"),
      [pendingOrder.connector.id],
    );
    expect(orderRepository.save).toHaveBeenCalledTimes(1);
    expect(paymentRepository.save).toHaveBeenCalledTimes(1);
    expect(sessionRepository.save).toHaveBeenCalledTimes(1);
    expect(commandRepository.save).toHaveBeenCalledTimes(1);
    expect(pendingOrder.status).toBe(OrderStatus.PAID);
    expect(payment.status).toBe(PaymentTransactionStatus.PAID);
    expect(payment.paymentLinkId).toBe("pl_123");
    expect(commandRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ commandType: "START_CHARGING" }),
    );
    expect(commandDispatcher.dispatchWhenIotReady).toHaveBeenCalledWith(
      commandRepository.create.mock.results[0]?.value.commandId,
    );
    expect(gateway.publishOrder).toHaveBeenCalledWith(
      pendingOrder.id,
      "payment.updated",
      {
        orderId: pendingOrder.id,
        status: OrderStatus.PAID,
        sessionId: sessionRepository.create.mock.results[0]?.value.id,
      },
    );
    expect(gateway.publishSession).toHaveBeenCalledWith(
      sessionRepository.create.mock.results[0]?.value.id,
      "session.updated",
      ChargingSessionStatus.PENDING,
    );
  });

  it("does not open a database transaction for an invalid signature", async () => {
    const dataSource = { transaction: vi.fn() };
    const client = { verifyWebhook: vi.fn().mockReturnValue(false) };
    const service = new PaymentsService(
      dataSource as unknown as DataSource,
      client as unknown as PayosClient,
    );

    await expect(
      service.handleWebhook({
        code: "00",
        success: true,
        signature: "invalid",
        data: { orderCode: 100001, amount: 10000 },
      }),
    ).rejects.toThrow("Invalid PayOS webhook signature");

    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it.each([
    {
      webhookStatus: "FAILED",
      paymentStatus: PaymentTransactionStatus.FAILED,
      orderStatus: OrderStatus.PAYMENT_FAILED,
    },
    {
      webhookStatus: "CANCELLED",
      paymentStatus: PaymentTransactionStatus.FAILED,
      orderStatus: OrderStatus.PAYMENT_FAILED,
    },
    {
      webhookStatus: "EXPIRED",
      paymentStatus: PaymentTransactionStatus.EXPIRED,
      orderStatus: OrderStatus.EXPIRED,
    },
  ])(
    "publishes payment.updated after persisting a $webhookStatus webhook transition",
    async ({ webhookStatus, paymentStatus, orderStatus }) => {
      const order = {
        id: randomUUID(),
        payosOrderCode: "100001",
        amountVnd: 10000,
        status: OrderStatus.PENDING_PAYMENT,
        connector: { id: randomUUID() },
      } as Order;
      const payment = {
        id: randomUUID(),
        status: PaymentTransactionStatus.PENDING,
        order,
      } as PaymentTransaction;
      const connector = { id: order.connector.id, status: "OCCUPIED" };
      const paymentRepository = {
        findOne: vi.fn().mockResolvedValue(payment),
        save: vi.fn().mockImplementation(async (entity) => entity),
      };
      const orderRepository = {
        save: vi.fn().mockImplementation(async (entity) => entity),
      };
      const connectorRepository = {
        findOne: vi.fn().mockResolvedValue(connector),
        save: vi.fn().mockImplementation(async (entity) => entity),
      };
      const manager = {
        query: vi.fn().mockImplementation(async (query: string) => {
          if (query.includes("FROM payment_transactions")) {
            return [{ id: payment.id }];
          }
          if (query.includes("FROM connectors")) {
            return [{ id: connector.id }];
          }
          throw new Error("Unexpected lock query");
        }),
        getRepository: vi.fn((entity) => {
          if (entity === PaymentTransaction) return paymentRepository;
          if (entity === Order) return orderRepository;
          if (entity === Connector) return connectorRepository;
          if (entity === ChargingSession || entity === DeviceCommand) return {};
          throw new Error("Unexpected repository");
        }),
      };
      let transactionCommitted = false;
      const dataSource = {
        transaction: vi.fn(async (callback) => {
          const result = await callback(manager);
          transactionCommitted = true;
          return result;
        }),
      };
      const gateway = {
        publishOrder: vi.fn(() => {
          expect(transactionCommitted).toBe(true);
        }),
      };
      const service = new PaymentsService(
        dataSource as unknown as DataSource,
        {
          verifyWebhook: vi.fn().mockReturnValue(true),
        } as unknown as PayosClient,
        undefined,
        gateway as unknown as ChargeGateway,
      );

      await service.handleWebhook({
        code: "01",
        success: false,
        signature: "valid",
        data: {
          orderCode: 100001,
          amount: 10000,
          status: webhookStatus,
        },
      });

      expect(payment.status).toBe(paymentStatus);
      expect(order.status).toBe(orderStatus);
      expect(gateway.publishOrder).toHaveBeenCalledWith(
        order.id,
        "payment.updated",
        {
          orderId: order.id,
          status: orderStatus,
        },
      );
    },
  );
});
