import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from './auth/auth.module.js';
import { databaseOptions } from './database/data-source.js';
import { ConnectorsModule } from './connectors/connectors.module.js';

@Module({
  imports: [
    TypeOrmModule.forRoot(databaseOptions),
    AuthModule,
    ConnectorsModule,
  ],
})
export class AppModule {}
