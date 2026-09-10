import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";

import { UserRole } from "../database/data-source.js";
import type { AuthenticatedRequest } from "../auth/jwt-auth.guard.js";

@Injectable()
export class AdminOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.user.role !== UserRole.ADMIN) {
      throw new ForbiddenException("Administrator access is required");
    }
    return true;
  }
}
