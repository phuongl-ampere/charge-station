import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { ChargingModule } from "../charging/charging.module.js";
import { IotModule } from "../iot/iot.module.js";
import { StationsModule } from "../stations/stations.module.js";
import { AdminAccessGuard } from "./admin-access.guard.js";
import { AdminOnlyGuard } from "./admin-only.guard.js";
import { AdminController } from "./admin.controller.js";
import { AdminService } from "./admin.service.js";
import { DevicesController } from "./devices.controller.js";
import { DevicesService } from "./devices.service.js";

@Module({
  imports: [AuthModule, ChargingModule, IotModule, StationsModule],
  controllers: [AdminController, DevicesController],
  providers: [
    AdminAccessGuard,
    AdminOnlyGuard,
    AdminService,
    DevicesService,
  ],
})
export class AdminModule {}
