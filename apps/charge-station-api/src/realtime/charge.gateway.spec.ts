import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataSource } from "typeorm";

import { ChargingSession } from "../database/data-source.js";
import type { AuthService } from "../auth/auth.service.js";
import { ChargeGateway } from "./charge.gateway.js";

describe("ChargeGateway", () => {
  afterEach(() => {
    delete process.env.JWT_SECRET;
  });

  it("joins a session room only when its order matches a short-lived signed token", async () => {
    process.env.JWT_SECRET = "test-secret";
    const client = { join: vi.fn() };
    const sessionRepository = {
      findOneBy: vi.fn().mockResolvedValue({
        id: "ses_1",
        order: { id: "ord_1" },
      }),
    };
    const gateway = new ChargeGateway(
      {
        getRepository: () => sessionRepository,
      } as unknown as DataSource,
      { verifyToken: vi.fn() } as unknown as AuthService,
    );
    const accessToken = gateway.issueAccessToken("ord_1");

    await expect(
      gateway.subscribe(client, {
        sessionId: "ses_1",
        accessToken,
      }),
    ).resolves.toEqual({ subscribed: "session:ses_1" });

    expect(sessionRepository.findOneBy).toHaveBeenCalledWith({ id: "ses_1" });
    expect(client.join).toHaveBeenCalledWith("session:ses_1");
  });

  it("rejects a signed token scoped to another order", async () => {
    process.env.JWT_SECRET = "test-secret";
    const client = { join: vi.fn() };
    const gateway = new ChargeGateway(
      {
        getRepository: () => ({
          findOneBy: vi.fn().mockResolvedValue({
            id: "ses_1",
            order: { id: "ord_1" },
          }),
        }),
      } as unknown as DataSource,
      { verifyToken: vi.fn() } as unknown as AuthService,
    );

    await expect(
      gateway.subscribe(client, {
        sessionId: "ses_1",
        accessToken: gateway.issueAccessToken("ord_2"),
      }),
    ).rejects.toThrow("Subscription token does not match order");
    expect(client.join).not.toHaveBeenCalled();
  });
});
