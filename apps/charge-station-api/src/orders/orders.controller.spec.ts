import { describe, expect, it } from "vitest";

import type { OrdersService } from "./orders.service.js";
import { OrdersController } from "./orders.controller.js";

describe("OrdersController", () => {
  it("delegates GET /orders/:id to the order status projection", async () => {
    const service = {
      getOrder: async (id: string) => ({ id, status: "PAID" }),
    };
    const controller = new OrdersController(
      service as unknown as OrdersService,
    );

    await expect(controller.getOrder("ord_1")).resolves.toEqual({
      id: "ord_1",
      status: "PAID",
    });
  });
});
