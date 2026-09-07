import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChargingStatus } from "./ChargingStatus";
import { createChargeSocket } from "../lib/socket";

vi.mock("../lib/socket", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/socket")>();
  return {
    ...original,
    createChargeSocket: vi.fn(),
  };
});

describe("ChargingStatus", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
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

  it("waits for a hydrated token before joining a paid order and its session", async () => {
    const listeners = new Map<string, (payload?: unknown) => void>();
    const socket = {
      connected: false,
      disconnect: vi.fn(),
      emit: vi.fn(),
      off: vi.fn((event: string) => listeners.delete(event)),
      on: vi.fn((event: string, listener: (payload?: unknown) => void) => {
        listeners.set(event, listener);
      }),
    };
    vi.mocked(createChargeSocket).mockReturnValue(socket);
    const api = {
      getOrder: vi.fn().mockResolvedValue({
        amountVnd: 10000,
        connectorCode: "ST01-C01",
        currency: "VND",
        durationMinutes: 120,
        id: "ord_1",
        payment: { provider: "PAYOS", status: "PAID" },
        sessionId: "ses_1",
        status: "PAID",
      }),
      getSession: vi.fn().mockResolvedValue({
        estimatedRemainingSeconds: 3450,
        id: "ses_1",
        lastDeviceEventAt: null,
        operationalWarning: null,
        orderId: "ord_1",
        status: "STARTING",
        timerAuthority: "DEVICE",
      }),
      stopSession: vi.fn().mockResolvedValue({ accepted: true }),
    };

    const view = render(<ChargingStatus orderId="ord_1" api={api} />);

    await waitFor(() => expect(api.getSession).toHaveBeenCalledWith("ses_1"));
    expect(createChargeSocket).not.toHaveBeenCalled();

    view.rerender(
      <ChargingStatus
        orderId="ord_1"
        accessToken="hydrated-order-token"
        api={api}
      />,
    );

    await waitFor(() => expect(createChargeSocket).toHaveBeenCalledTimes(1));
    await act(async () => {
      listeners.get("connect")?.();
    });

    await waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith("subscribe", {
        orderId: "ord_1",
        accessToken: "hydrated-order-token",
      });
      expect(socket.emit).toHaveBeenCalledWith("subscribe", {
        sessionId: "ses_1",
        accessToken: "hydrated-order-token",
      });
    });

    await act(async () => {
      listeners.get("session.updated")?.("CHARGING");
    });
    expect(
      await screen.findByRole("heading", { name: "Charging" }),
    ).toBeVisible();
    await screen.findByRole("button", { name: "Stop charging" });
    await act(async () => {
      await screen.getByRole("button", { name: "Stop charging" }).click();
    });
    expect(api.stopSession).toHaveBeenCalledWith(
      "ses_1",
      "hydrated-order-token",
    );

    await act(async () => {
      listeners.get("device.updated")?.("COMPLETED");
    });
    expect(
      await screen.findByRole("heading", { name: "Charge complete" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Stop charging" }),
    ).not.toBeInTheDocument();
  });

  it("recreates only its matching local socket when the token changes", async () => {
    const firstSocket = {
      connected: false,
      disconnect: vi.fn(),
      emit: vi.fn(),
      off: vi.fn(),
      on: vi.fn(),
    };
    const secondSocket = {
      connected: false,
      disconnect: vi.fn(),
      emit: vi.fn(),
      off: vi.fn(),
      on: vi.fn(),
    };
    vi.mocked(createChargeSocket)
      .mockReturnValueOnce(firstSocket)
      .mockReturnValueOnce(secondSocket);
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

    const view = render(
      <ChargingStatus
        orderId="ord_1"
        accessToken="first-order-token"
        api={api}
      />,
    );
    await waitFor(() => expect(createChargeSocket).toHaveBeenCalledTimes(1));

    view.rerender(
      <ChargingStatus
        orderId="ord_1"
        accessToken="second-order-token"
        api={api}
      />,
    );
    await waitFor(() => expect(createChargeSocket).toHaveBeenCalledTimes(2));

    expect(firstSocket.disconnect).toHaveBeenCalledTimes(1);
    expect(secondSocket.disconnect).not.toHaveBeenCalled();

    view.unmount();
    expect(secondSocket.disconnect).toHaveBeenCalledTimes(1);
  });
});
