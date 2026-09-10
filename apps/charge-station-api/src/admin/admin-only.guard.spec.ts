import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { UserRole } from "../database/data-source.js";
import { AdminOnlyGuard } from "./admin-only.guard.js";

describe("AdminOnlyGuard", () => {
  it("allows an administrator to manage station QR assets", () => {
    const guard = new AdminOnlyGuard();
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ user: { sub: "admin-1", role: UserRole.ADMIN } }),
      }),
    };

    expect(guard.canActivate(context as never)).toBe(true);
  });

  it("rejects an operator from station configuration changes", () => {
    const guard = new AdminOnlyGuard();
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          user: { sub: "operator-1", role: UserRole.OPERATOR },
        }),
      }),
    };

    expect(() => guard.canActivate(context as never)).toThrow(
      ForbiddenException,
    );
  });
});
