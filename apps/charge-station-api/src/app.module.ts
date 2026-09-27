import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { AdminModule } from "./admin/admin.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { ChargingModule } from "./charging/charging.module.js";
import { databaseOptions } from "./database/data-source.js";
import { HealthController } from "./health.controller.js";
import { OrdersModule } from "./orders/orders.module.js";
import { PaymentsModule } from "./payments/payments.module.js";
import { RealtimeModule } from "./realtime/realtime.module.js";
import { StationsModule } from "./stations/stations.module.js";

@Module({
  controllers: [HealthController],
  imports: [
    TypeOrmModule.forRoot(databaseOptions),
    AdminModule,
    AuthModule,
    ChargingModule,
    OrdersModule,
    PaymentsModule,
    RealtimeModule,
    StationsModule,
  ],
})
export class AppModule {}
