import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { Connector, Station } from "../database/data-source.js";
import { StationQrService } from "./station-qr.service.js";
import { StationScanService } from "./station-scan.service.js";
import { StationsController } from "./stations.controller.js";

@Module({
  imports: [TypeOrmModule.forFeature([Connector, Station])],
  controllers: [StationsController],
  providers: [StationQrService, StationScanService],
  exports: [StationQrService],
})
export class StationsModule {}
