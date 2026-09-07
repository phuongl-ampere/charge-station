import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";

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
