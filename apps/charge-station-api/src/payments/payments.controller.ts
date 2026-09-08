import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type { Response } from "express";

import { CreateOrderDto } from "./dto/create-order.dto.js";
import { PaymentsService } from "./payments.service.js";

@Controller()
export class PaymentsController {
  constructor(
    @Inject(PaymentsService) private readonly paymentsService: PaymentsService,
  ) {}

  @Post("orders")
  createOrder(@Body() input: CreateOrderDto) {
    return this.paymentsService.createOrder(input);
  }

  @Post("payments/payos/webhook")
  handleWebhook(@Body() body: unknown) {
    return this.paymentsService.handleWebhook(body);
  }

  @Get("payments/payos/mock/:orderCode")
  @Header("content-type", "text/html; charset=utf-8")
  async getMockCheckout(
    @Param("orderCode") orderCode: string,
  ): Promise<string> {
    return renderMockCheckout(
      await this.paymentsService.getMockCheckout(orderCode),
    );
  }

  @Post("payments/payos/mock/:orderCode/complete")
  completeMockCheckout(@Param("orderCode") orderCode: string) {
    return this.paymentsService.completeMockCheckout(orderCode);
  }

  @Post("payments/payos/mock/:orderCode/cancel")
  cancelMockCheckout(@Param("orderCode") orderCode: string) {
    return this.paymentsService.cancelMockCheckout(orderCode);
  }

  @Get("payments/payos/return")
  async handleReturn(
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ): Promise<void> {
    response.redirect(await this.getCallbackRedirect(query));
  }

  @Get("payments/payos/cancel")
  async handleCancel(
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ): Promise<void> {
    response.redirect(await this.getCallbackRedirect(query));
  }

  private async getCallbackRedirect(
    query: Record<string, unknown>,
  ): Promise<string> {
    const { signature, ...data } = query;
    if (typeof signature !== "string") {
      throw new BadRequestException("PayOS callback signature is required");
    }
    return this.paymentsService.getCallbackRedirect(data, signature);
  }
}

function renderMockCheckout(checkout: {
  orderCode: number;
  amount: number;
  currency: string;
  status: string;
}): string {
  const checkoutPath = `/payments/payos/mock/${checkout.orderCode}`;
  const actions =
    checkout.status === "PENDING"
      ? [
          `<form method="post" action="${checkoutPath}/complete">`,
          '<button type="submit">Complete payment</button>',
          "</form>",
          `<form method="post" action="${checkoutPath}/cancel">`,
          '<button type="submit">Cancel payment</button>',
          "</form>",
        ].join("")
      : `<p>Payment status: ${checkout.status}</p>`;

  return [
    "<!doctype html>",
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>Mock PayOS Checkout</title></head>',
    "<body>",
    "<main>",
    "<h1>Mock PayOS Checkout</h1>",
    `<p>Order ${checkout.orderCode}</p>`,
    `<p>Amount ${checkout.amount} ${checkout.currency}</p>`,
    actions,
    "</main>",
    "</body>",
    "</html>",
  ].join("");
}
