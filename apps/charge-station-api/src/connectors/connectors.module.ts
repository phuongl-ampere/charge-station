import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Connector } from '../database/data-source.js';
import { ConnectorsController } from './connectors.controller.js';
import { ConnectorsService } from './connectors.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Connector])],
  controllers: [ConnectorsController],
  providers: [ConnectorsService],
  exports: [ConnectorsService],
})
export class ConnectorsModule {}
