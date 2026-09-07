import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import {
  ChargingSession,
  Connector,
  DeviceCommand,
  Order,
  PaymentTransaction,
} from "../database/data-source.js";
import { IotModule } from "../iot/iot.module.js";
import { PayosClient } from "./payos.client.js";
import { PaymentsController } from "./payments.controller.js";
import { PaymentsService } from "./payments.service.js";

@Module({
  imports: [
    IotModule,
    TypeOrmModule.forFeature([
      ChargingSession,
      Connector,
      DeviceCommand,
      Order,
      PaymentTransaction,
    ]),
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService, PayosClient],
})
export class PaymentsModule {}
