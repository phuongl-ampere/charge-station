import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from './auth/auth.module.js';
import { ChargingModule } from './charging/charging.module.js';
import { databaseOptions } from './database/data-source.js';
import { ConnectorsModule } from './connectors/connectors.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';

@Module({
  imports: [
    TypeOrmModule.forRoot(databaseOptions),
    AuthModule,
    ChargingModule,
    ConnectorsModule,
    OrdersModule,
    PaymentsModule,
    RealtimeModule,
  ],
})
export class AppModule {}
