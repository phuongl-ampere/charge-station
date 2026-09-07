import { describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "@nestjs/common";

import { ServiceTokenGuard } from "./device-events.controller.js";

describe("ServiceTokenGuard", () => {
  it("requires the matching X-Service-Token for device events", () => {
    const originalToken = process.env.SERVICE_TOKEN;
    process.env.SERVICE_TOKEN = "local-token";
    const guard = new ServiceTokenGuard();

    expect(() => guard.canActivate(contextFor(undefined))).toThrow(
      "A valid service token is required",
    );
    expect(() => guard.canActivate(contextFor("wrong-token"))).toThrow(
      "A valid service token is required",
    );
    expect(guard.canActivate(contextFor("local-token"))).toBe(true);

    if (originalToken === undefined) {
      delete process.env.SERVICE_TOKEN;
    } else {
      process.env.SERVICE_TOKEN = originalToken;
    }
  });
});

function contextFor(token: string | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        header: vi.fn().mockReturnValue(token),
      }),
    }),
  } as unknown as ExecutionContext;
}
