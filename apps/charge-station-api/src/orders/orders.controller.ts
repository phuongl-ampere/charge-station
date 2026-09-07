import {
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  UnauthorizedException,
} from "@nestjs/common";

import { ChargeGateway } from "../realtime/charge.gateway.js";
import { PaymentsService } from "../payments/payments.service.js";
import { OrdersService } from "./orders.service.js";

@Controller("orders")
export class OrdersController {
  constructor(
    @Inject(OrdersService) private readonly ordersService: OrdersService,
    @Inject(ChargeGateway) private readonly chargeGateway: ChargeGateway,
    @Inject(PaymentsService)
    private readonly paymentsService: PaymentsService,
  ) {}

  @Get(":id")
  async getOrder(
    @Param("id") id: string,
    @Headers("authorization") authorization: string | undefined,
  ) {
    await this.chargeGateway.authorizeOrder(id, readBearerToken(authorization));
    return this.ordersService.getOrder(id);
  }

  @Get(":id/payment-link")
  async getPaymentLink(
    @Param("id") id: string,
    @Headers("authorization") authorization: string | undefined,
  ) {
    await this.chargeGateway.authorizeOrder(id, readBearerToken(authorization));
    return this.paymentsService.getPaymentLink(id);
  }
}

function readBearerToken(authorization: string | undefined): string {
  if (!authorization?.startsWith("Bearer ")) {
    throw new UnauthorizedException("Bearer token is required");
  }

  const token = authorization.slice("Bearer ".length).trim();
  if (!token) {
    throw new UnauthorizedException("Bearer token is required");
  }
  return token;
}
