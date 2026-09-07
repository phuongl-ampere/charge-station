import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import type { PayosWebhook } from './payos.client.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { PaymentsService } from './payments.service.js';

@Controller()
export class PaymentsController {
  constructor(
    @Inject(PaymentsService) private readonly paymentsService: PaymentsService,
  ) {}

  @Post('orders')
  createOrder(@Body() input: CreateOrderDto) {
    return this.paymentsService.createOrder(input);
  }

  @Post('payments/payos/webhook')
  handleWebhook(@Body() body: PayosWebhook) {
    return this.paymentsService.handleWebhook(body);
  }

  @Get('payments/payos/return')
  async handleReturn(
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ): Promise<void> {
    response.redirect(await this.getCallbackRedirect(query));
  }

  @Get('payments/payos/cancel')
  async handleCancel(
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ): Promise<void> {
    response.redirect(await this.getCallbackRedirect(query));
  }

  private async getCallbackRedirect(query: Record<string, unknown>): Promise<string> {
    const { signature, ...data } = query;
    if (typeof signature !== 'string') {
      throw new BadRequestException('PayOS callback signature is required');
    }
    return this.paymentsService.getCallbackRedirect(data, signature);
  }
}
