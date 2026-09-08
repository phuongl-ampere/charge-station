import { describe, expect, it, vi } from "vitest";

import { CommandDispatcherService } from "./iot/command-dispatcher.service.js";
import { PaymentExpirationService } from "./payments/payment-expiration.service.js";

const createApp = vi.hoisted(() => vi.fn());
const configureApp = vi.hoisted(() => vi.fn());

vi.mock("@nestjs/core", () => ({
  NestFactory: {
    create: createApp,
  },
}));

vi.mock("./app.module.js", () => ({
  AppModule: class AppModule {},
}));

vi.mock("./http-app.js", () => ({
  configureHttpApp: configureApp,
}));

describe("API bootstrap", () => {
  it("starts command recovery and payment expiration only after the listener is ready", async () => {
    let listening = false;
    const dispatcher = {
      dispatchPendingAfterReady: vi.fn(),
    };
    const paymentExpiration = {
      start: vi.fn(),
    };
    const app = {
      get: vi.fn((token: unknown) => {
        expect(listening).toBe(true);
        if (token === CommandDispatcherService) return dispatcher;
        if (token === PaymentExpirationService) return paymentExpiration;
        throw new Error("Unexpected provider");
      }),
      listen: vi.fn(async () => {
        listening = true;
      }),
    };
    createApp.mockResolvedValueOnce(app);

    await import("./main.js");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(configureApp).toHaveBeenCalledWith(app);
    expect(app.listen).toHaveBeenCalledWith(4000);
    expect(dispatcher.dispatchPendingAfterReady).toHaveBeenCalledOnce();
    expect(paymentExpiration.start).toHaveBeenCalledOnce();
  });
});
