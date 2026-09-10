import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { ChargingSession, DeviceCommand } from "../database/data-source.js";
import { IotModule } from "../iot/iot.module.js";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { ChargingController } from "./charging.controller.js";
import { ChargingService } from "./charging.service.js";

@Module({
  imports: [
    IotModule,
    RealtimeModule,
    TypeOrmModule.forFeature([ChargingSession, DeviceCommand]),
  ],
  controllers: [ChargingController],
  providers: [ChargingService],
  exports: [ChargingService],
})
export class ChargingModule {}
