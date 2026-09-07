import { describe, expect, it } from "vitest";

import type { ChargeGateway } from "../realtime/charge.gateway.js";
import type { OrdersService } from "./orders.service.js";
import type { PaymentsService } from "../payments/payments.service.js";
import { OrdersController } from "./orders.controller.js";

describe("OrdersController", () => {
  it("delegates GET /orders/:id to the order status projection", async () => {
    const service = {
      getOrder: async (id: string) => ({ id, status: "PAID" }),
    };
    const gateway = {
      authorizeOrder: async (id: string, token: string) => {
        expect(id).toBe("ord_1");
        expect(token).toBe("token");
      },
    };
    const payments = {
      getPaymentLink: async () => {
        throw new Error("not used");
      },
    };
    const controller = new OrdersController(
      service as unknown as OrdersService,
      gateway as unknown as ChargeGateway,
      payments as unknown as PaymentsService,
    );

    await expect(controller.getOrder("ord_1", "Bearer token")).resolves.toEqual(
      {
        id: "ord_1",
        status: "PAID",
      },
    );
  });

  it("authorizes GET /orders/:id/payment-link before recovering its checkout URL", async () => {
    const calls: string[] = [];
    const service = {
      getOrder: async () => {
        throw new Error("not used");
      },
    };
    const gateway = {
      authorizeOrder: async (id: string, token: string) => {
        calls.push("authorize");
        expect(id).toBe("ord_1");
        expect(token).toBe("token");
      },
    };
    const payments = {
      getPaymentLink: async (id: string) => {
        calls.push("recover");
        expect(id).toBe("ord_1");
        return {
          provider: "PAYOS" as const,
          checkoutUrl: "https://pay.example/100001",
        };
      },
    };
    const Controller = OrdersController as unknown as new (
      ordersService: OrdersService,
      chargeGateway: ChargeGateway,
      paymentsService: PaymentsService,
    ) => {
      getPaymentLink(id: string, authorization?: string): Promise<unknown>;
    };
    const controller = new Controller(
      service as unknown as OrdersService,
      gateway as unknown as ChargeGateway,
      payments as unknown as PaymentsService,
    );

    await expect(
      controller.getPaymentLink("ord_1", "Bearer token"),
    ).resolves.toEqual({
      provider: "PAYOS",
      checkoutUrl: "https://pay.example/100001",
    });
    expect(calls).toEqual(["authorize", "recover"]);
  });
});
