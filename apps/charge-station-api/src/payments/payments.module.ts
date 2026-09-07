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
import { RealtimeModule } from "../realtime/realtime.module.js";
import { PayosClient } from "./payos.client.js";
import { PaymentsController } from "./payments.controller.js";
import { PaymentsService } from "./payments.service.js";

@Module({
  imports: [
    IotModule,
    RealtimeModule,
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
  exports: [PaymentsService],
})
export class PaymentsModule {}
