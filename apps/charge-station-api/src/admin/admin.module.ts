import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { ChargingModule } from "../charging/charging.module.js";
import { StationsModule } from "../stations/stations.module.js";
import { AdminAccessGuard } from "./admin-access.guard.js";
import { AdminOnlyGuard } from "./admin-only.guard.js";
import { AdminController } from "./admin.controller.js";
import { AdminService } from "./admin.service.js";

@Module({
  imports: [AuthModule, ChargingModule, StationsModule],
  controllers: [AdminController],
  providers: [AdminAccessGuard, AdminOnlyGuard, AdminService],
})
export class AdminModule {}
