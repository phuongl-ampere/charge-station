import { UnauthorizedException } from "@nestjs/common";
import jwt from "jsonwebtoken";
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

  it("keeps an order capability valid through the three-hour charging window and expires it after four hours", async () => {
    process.env.JWT_SECRET = "test-secret";
    vi.useFakeTimers();
    const issuedAt = new Date("2026-09-08T00:00:00.000Z");
    vi.setSystemTime(issuedAt);
    const gateway = new ChargeGateway(
      {
        getRepository: () => ({
          findOneBy: vi.fn().mockResolvedValue({
            id: "ses_1",
            order: { id: "ord_1" },
          }),
        }),
      } as unknown as DataSource,
      {
        verifyToken: vi.fn(() => {
          throw new UnauthorizedException("Invalid token");
        }),
      } as unknown as AuthService,
    );
    const accessToken = gateway.issueAccessToken("ord_1");
    const payload = jwt.decode(accessToken);

    expect(payload).toMatchObject({
      orderId: "ord_1",
      type: "charge-realtime",
    });
    expect(
      (payload as jwt.JwtPayload).exp! - (payload as jwt.JwtPayload).iat!,
    ).toBe(4 * 60 * 60);

    vi.setSystemTime(new Date(issuedAt.valueOf() + (4 * 60 * 60 - 1) * 1_000));
    await expect(
      gateway.authorizeSession("ses_1", accessToken),
    ).resolves.toBeUndefined();

    vi.setSystemTime(new Date(issuedAt.valueOf() + 4 * 60 * 60 * 1_000));
    await expect(
      gateway.authorizeSession("ses_1", accessToken),
    ).rejects.toThrow("Invalid token");
  });
});
