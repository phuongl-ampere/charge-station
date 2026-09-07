import { describe, expect, it } from "vitest";

import type { ChargeGateway } from "../realtime/charge.gateway.js";
import type { OrdersService } from "./orders.service.js";
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
    const controller = new OrdersController(
      service as unknown as OrdersService,
      gateway as unknown as ChargeGateway,
    );

    await expect(controller.getOrder("ord_1", "Bearer token")).resolves.toEqual(
      {
        id: "ord_1",
        status: "PAID",
      },
    );
  });
});
