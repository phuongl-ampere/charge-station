import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
} from "@nestjs/common";

import { ChargingService } from "./charging.service.js";

@Controller()
export class ChargingController {
  constructor(
    @Inject(ChargingService)
    private readonly chargingService: ChargingService,
  ) {}

  @Get("sessions/:id")
  getSession(@Param("id") id: string): Promise<unknown> {
    return this.chargingService.getSession(id);
  }

  @Post("sessions/:id/stop")
  @HttpCode(HttpStatus.ACCEPTED)
  stopSession(@Param("id") id: string): Promise<unknown> {
    return this.chargingService.stopSession(id);
  }
}
