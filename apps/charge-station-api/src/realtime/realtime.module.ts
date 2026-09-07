import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { AuthModule } from "../auth/auth.module.js";
import { ChargingSession, Order } from "../database/data-source.js";
import { ChargeGateway } from "./charge.gateway.js";

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([ChargingSession, Order])],
  providers: [ChargeGateway],
  exports: [ChargeGateway],
})
export class RealtimeModule {}
