import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChargingStatus } from "./ChargingStatus";

describe("ChargingStatus", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls session status every five seconds after socket disconnect", async () => {
    vi.useFakeTimers();
    const disconnectedSocket = {
      connected: false,
      emit: vi.fn(),
      off: vi.fn(),
      on: vi.fn(),
    };
    const api = {
      getOrder: vi.fn().mockResolvedValue({
        amountVnd: 10000,
        connectorCode: "ST01-C01",
        currency: "VND",
        durationMinutes: 120,
        id: "ord_1",
        payment: { provider: "PAYOS", status: "PENDING" },
        status: "PENDING_PAYMENT",
      }),
      getSession: vi.fn(),
      stopSession: vi.fn(),
    };

    render(
      <ChargingStatus orderId="ord_1" socket={disconnectedSocket} api={api} />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(api.getOrder).toHaveBeenCalledWith("ord_1");
  });
});
