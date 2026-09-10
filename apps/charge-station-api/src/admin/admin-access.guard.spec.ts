import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { UserRole } from "../database/data-source.js";
import { AdminAccessGuard } from "./admin-access.guard.js";

describe("AdminAccessGuard", () => {
  it.each([UserRole.ADMIN, UserRole.OPERATOR])(
    "allows %s users into the operations console",
    (role) => {
      const guard = new AdminAccessGuard();
      const context = {
        switchToHttp: () => ({
          getRequest: () => ({ user: { sub: "user-1", role } }),
        }),
      };

      expect(guard.canActivate(context as never)).toBe(true);
    },
  );

  it("rejects a customer token", () => {
    const guard = new AdminAccessGuard();
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          user: { sub: "customer-1", role: UserRole.CUSTOMER },
        }),
      }),
    };

    expect(() => guard.canActivate(context as never)).toThrow(
      ForbiddenException,
    );
  });
});
