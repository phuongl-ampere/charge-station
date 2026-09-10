import { Controller, Get, Inject, Param } from "@nestjs/common";

import { StationScanService } from "./station-scan.service.js";

@Controller("public/stations")
export class StationsController {
  constructor(
    @Inject(StationScanService)
    private readonly stationScanService: StationScanService,
  ) {}

  @Get("scan/:token")
  getStationScan(@Param("token") token: string) {
    return this.stationScanService.getStationScan(token);
  }
}
