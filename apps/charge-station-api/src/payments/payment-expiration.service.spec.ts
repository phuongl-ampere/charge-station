import { afterEach, describe, expect, it, vi } from "vitest";

import { PaymentExpirationService } from "./payment-expiration.service.js";
import type { PaymentsService } from "./payments.service.js";

describe("PaymentExpirationService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs immediately, keeps an unrefed reaper interval, and clears it on shutdown", async () => {
    const timer = { unref: vi.fn() } as unknown as ReturnType<
      typeof setInterval
    >;
    const expireDueReservations = vi.fn().mockResolvedValue(0);
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue(timer);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const service = new PaymentExpirationService({
      expireDueReservations,
    } as unknown as PaymentsService);

    service.start();
    await Promise.resolve();

    expect(expireDueReservations).toHaveBeenCalledOnce();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect(timer.unref).toHaveBeenCalledOnce();

    service.onApplicationShutdown();

    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
  });
});
