import { Controller, Get, Inject, Param } from "@nestjs/common";

import { OrdersService } from "./orders.service.js";

@Controller("orders")
export class OrdersController {
  constructor(
    @Inject(OrdersService) private readonly ordersService: OrdersService,
  ) {}

  @Get(":id")
  getOrder(@Param("id") id: string) {
    return this.ordersService.getOrder(id);
  }
}
