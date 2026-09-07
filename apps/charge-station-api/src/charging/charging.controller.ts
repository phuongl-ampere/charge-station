import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  UnauthorizedException,
} from "@nestjs/common";

import { ChargeGateway } from "../realtime/charge.gateway.js";
import { ChargingService } from "./charging.service.js";

@Controller()
export class ChargingController {
  constructor(
    @Inject(ChargingService)
    private readonly chargingService: ChargingService,
    @Inject(ChargeGateway)
    private readonly chargeGateway: ChargeGateway,
  ) {}

  @Get("sessions/:id")
  getSession(@Param("id") id: string): Promise<unknown> {
    return this.chargingService.getSession(id);
  }

  @Post("sessions/:id/stop")
  @HttpCode(HttpStatus.ACCEPTED)
  async stopSession(
    @Param("id") id: string,
    @Headers("authorization") authorization: string | undefined,
  ): Promise<unknown> {
    await this.chargeGateway.authorizeSession(
      id,
      readBearerToken(authorization),
    );
    return this.chargingService.stopSession(id);
  }
}

function readBearerToken(authorization: string | undefined): string {
  if (!authorization?.startsWith("Bearer ")) {
    throw new UnauthorizedException("Bearer token is required");
  }

  const token = authorization.slice("Bearer ".length).trim();
  if (!token) {
    throw new UnauthorizedException("Bearer token is required");
  }
  return token;
}
