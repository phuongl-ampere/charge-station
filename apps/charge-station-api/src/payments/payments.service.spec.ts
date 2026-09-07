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
import { IotTransportError } from "../iot/iot-service.client.js";
import type { ChargeGateway } from "../realtime/charge.gateway.js";
import type { PayosClient } from "./payos.client.js";
import type { PayosWebhook } from "./payos.client.js";
import { PaymentsService } from "./payments.service.js";

describe("PaymentsService webhook processing", () => {
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

  it("returns success after payment while a provider transport retry dispatch rejects asynchronously", async () => {
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
    let rejectDispatch: (error: Error) => void = () => undefined;
    const commandDispatcher = {
      dispatch: vi.fn(() => {
        expect(transactionCommitted).toBe(true);
        return new Promise<void>((_resolve, reject) => {
          rejectDispatch = reject;
        });
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

    const logger = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const webhook = service.handleWebhook(body);
    const response = await Promise.race([
      webhook,
      new Promise<"timed out">((resolve) => {
        setTimeout(() => resolve("timed out"), 25);
      }),
    ]);
    rejectDispatch(new IotTransportError("IoT transport unavailable"));
    await expect(webhook).resolves.toEqual({ success: true });
    await vi.waitFor(() => {
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining("Failed to dispatch start command"),
        expect.any(String),
      );
    });
    logger.mockRestore();

    expect(response).toEqual({ success: true });
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
    expect(commandDispatcher.dispatch).toHaveBeenCalledWith(
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
