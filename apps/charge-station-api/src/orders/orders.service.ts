import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";

import { Order, PaymentTransaction } from "../database/data-source.js";

@Injectable()
export class OrdersService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async getOrder(id: string) {
    const order = await this.dataSource.getRepository(Order).findOneBy({ id });
    if (!order) {
      throw new NotFoundException("Order not found");
    }
    const payment = await this.dataSource
      .getRepository(PaymentTransaction)
      .findOne({
        where: { order: { id: order.id } },
      });

    return {
      id: order.id,
      status: order.status,
      amountVnd: order.amountVnd,
      currency: order.currency,
      durationMinutes: order.durationMinutes,
      connectorCode: order.connector.code,
      payment: payment
        ? {
            provider: payment.provider,
            status: payment.status,
            checkoutUrl: payment.checkoutUrl,
          }
        : null,
    };
  }
}
