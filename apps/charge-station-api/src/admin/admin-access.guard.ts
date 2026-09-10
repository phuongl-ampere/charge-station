import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";

import { UserRole } from "../database/data-source.js";
import type { AuthenticatedRequest } from "../auth/jwt-auth.guard.js";

@Injectable()
export class AdminAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (
      request.user.role !== UserRole.ADMIN &&
      request.user.role !== UserRole.OPERATOR
    ) {
      throw new ForbiddenException("Operations access is required");
    }

    return true;
  }
}
