import { describe, expect, it } from "vitest";
import type { DataSource } from "typeorm";

import {
  Order,
  OrderStatus,
  PaymentTransaction,
  PaymentTransactionStatus,
} from "../database/data-source.js";
import { OrdersService } from "./orders.service.js";

describe("OrdersService", () => {
  it("returns the persisted order and payment status", async () => {
    const orderRepository = {
      findOneBy: async () => ({
        id: "ord_1",
        status: OrderStatus.PAID,
        amountVnd: 10000,
        currency: "VND",
        durationMinutes: 120,
        connector: { code: "ST01-C01" },
      }),
    };
    const paymentRepository = {
      findOne: async () => ({
        provider: "PAYOS",
        status: PaymentTransactionStatus.PAID,
        checkoutUrl: "http://localhost:4000/mock-checkout",
      }),
    };
    const service = new OrdersService({
      getRepository: (entity: unknown) => {
        if (entity === Order) return orderRepository;
        if (entity === PaymentTransaction) return paymentRepository;
        throw new Error("Unexpected repository");
      },
    } as unknown as DataSource);

    await expect(service.getOrder("ord_1")).resolves.toEqual({
      id: "ord_1",
      status: "PAID",
      amountVnd: 10000,
      currency: "VND",
      durationMinutes: 120,
      connectorCode: "ST01-C01",
      payment: {
        provider: "PAYOS",
        status: "PAID",
        checkoutUrl: "http://localhost:4000/mock-checkout",
      },
    });
  });
});
