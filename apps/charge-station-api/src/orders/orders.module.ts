import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { Order, PaymentTransaction } from "../database/data-source.js";
import { OrdersController } from "./orders.controller.js";
import { OrdersService } from "./orders.service.js";

@Module({
  imports: [TypeOrmModule.forFeature([Order, PaymentTransaction])],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
