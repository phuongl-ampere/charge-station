import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";

import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { AdminAccessGuard } from "./admin-access.guard.js";
import { AdminOnlyGuard } from "./admin-only.guard.js";
import { DevicesService } from "./devices.service.js";

@Controller("admin/devices")
@UseGuards(JwtAuthGuard, AdminAccessGuard, AdminOnlyGuard)
export class DevicesController {
  constructor(@Inject(DevicesService) private readonly devices: DevicesService) {}

  @Get()
  list() {
    return this.devices.list();
  }

  @Get(":deviceId")
  get(@Param("deviceId") deviceId: string) {
    return this.devices.get(deviceId);
  }

  @Post(":deviceId/hold")
  hold(@Param("deviceId") deviceId: string) {
    return this.devices.setHold(deviceId, true);
  }

  @Post(":deviceId/release")
  release(@Param("deviceId") deviceId: string) {
    return this.devices.setHold(deviceId, false);
  }

  @Post(":deviceId/relays/:relayId")
  controlRelay(
    @Param("deviceId") deviceId: string,
    @Param("relayId") relayId: string,
    @Body() input: { enabled: boolean; durationSeconds?: number },
  ) {
    return this.devices.controlRelay(deviceId, relayId, input);
  }
}
