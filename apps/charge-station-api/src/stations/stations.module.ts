import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import {
  Connector,
  ManagedDevice,
  Station,
  StationQrToken,
} from "../database/data-source.js";
import { IotModule } from "../iot/iot.module.js";
import { StationQrService } from "./station-qr.service.js";
import { StationScanService } from "./station-scan.service.js";
import { StationsController } from "./stations.controller.js";

@Module({
  imports: [
    IotModule,
    TypeOrmModule.forFeature([Connector, ManagedDevice, Station, StationQrToken]),
  ],
  controllers: [StationsController],
  providers: [StationQrService, StationScanService],
  exports: [StationQrService],
})
export class StationsModule {}
