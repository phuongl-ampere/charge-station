import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";

import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { ChargingService } from "../charging/charging.service.js";
import { AdminAccessGuard } from "./admin-access.guard.js";
import { AdminOnlyGuard } from "./admin-only.guard.js";
import { AdminService } from "./admin.service.js";
import { CreateStationDto } from "./dto/create-station.dto.js";

@Controller("admin")
@UseGuards(JwtAuthGuard, AdminAccessGuard)
export class AdminController {
  constructor(
    @Inject(AdminService) private readonly adminService: AdminService,
    @Inject(ChargingService)
    private readonly chargingService: ChargingService,
  ) {}

  @Get("overview")
  getOverview() {
    return this.adminService.getOverview();
  }

  @Get("stations")
  getStations() {
    return this.adminService.getStations();
  }

  @Post("stations")
  @UseGuards(AdminOnlyGuard)
  createStation(@Body() input: CreateStationDto) {
    return this.adminService.createStation(input);
  }

  @Put("stations/:id/device")
  @UseGuards(AdminOnlyGuard)
  linkDevice(
    @Param("id") id: string,
    @Body() input: { deviceId: string },
  ) {
    return this.adminService.linkDevice(id, input.deviceId);
  }

  @Get("stations/:id/qr")
  @UseGuards(AdminOnlyGuard)
  getStationQr(@Param("id") id: string) {
    return this.adminService.getStationQr(id);
  }

  @Post("stations/:id/qr/rotate")
  @UseGuards(AdminOnlyGuard)
  rotateStationQr(@Param("id") id: string) {
    return this.adminService.rotateStationQr(id);
  }

  @Get("sessions")
  getSessions(@Query("limit") limit?: string) {
    return this.adminService.getSessions(parseLimit(limit, 50));
  }

  @Get("payments")
  getPayments(@Query("limit") limit?: string) {
    return this.adminService.getPayments(parseLimit(limit, 50));
  }

  @Get("device-timeline")
  getDeviceTimeline(@Query("limit") limit?: string) {
    return this.adminService.getDeviceTimeline(parseLimit(limit, 100));
  }

  @Post("sessions/:id/stop")
  @HttpCode(HttpStatus.ACCEPTED)
  stopSession(@Param("id") id: string) {
    return this.chargingService.stopSession(id);
  }

  @Post("sessions/:id/retry-start")
  @HttpCode(HttpStatus.ACCEPTED)
  retryStart(@Param("id") id: string) {
    return this.chargingService.retryStart(id);
  }
}

function parseLimit(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
