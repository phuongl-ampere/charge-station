import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Injectable,
  Post,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";

import { DeviceEventsService } from "./device-events.service.js";

@Injectable()
export class ServiceTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const expectedToken = process.env.SERVICE_TOKEN;
    const providedToken = request.header("X-Service-Token");

    if (!expectedToken || !providedToken || providedToken !== expectedToken) {
      throw new UnauthorizedException("A valid service token is required");
    }
    return true;
  }
}

@Controller("internal/device-events")
@UseGuards(ServiceTokenGuard)
export class DeviceEventsController {
  constructor(private readonly deviceEventsService: DeviceEventsService) {}

  @Post()
  handle(@Body() body: unknown) {
    return this.deviceEventsService.handle(body);
  }
}
