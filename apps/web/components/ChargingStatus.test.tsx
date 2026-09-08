import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
      retryStart: vi.fn(),
    };

    render(
      <ChargingStatus
        orderId="ord_1"
        accessToken="hydrated-order-token"
        socket={disconnectedSocket}
        api={api}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(api.getOrder).toHaveBeenCalledWith("ord_1", "hydrated-order-token");
  });

  it("does not request order status before its token hydrates", async () => {
    vi.mocked(createChargeSocket).mockReturnValue({
      connected: false,
      disconnect: vi.fn(),
      emit: vi.fn(),
      off: vi.fn(),
      on: vi.fn(),
    });
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
      getSession: vi.fn(),
      stopSession: vi.fn(),
      retryStart: vi.fn(),
    };

    const view = render(<ChargingStatus orderId="ord_1" api={api} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.getOrder).not.toHaveBeenCalled();

    view.rerender(
      <ChargingStatus
        orderId="ord_1"
        accessToken="hydrated-order-token"
        api={api}
      />,
    );
    await waitFor(() =>
      expect(api.getOrder).toHaveBeenCalledWith(
        "ord_1",
        "hydrated-order-token",
      ),
    );
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
      retryStart: vi.fn().mockResolvedValue({ accepted: true }),
    };

    const view = render(<ChargingStatus orderId="ord_1" api={api} />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(api.getOrder).not.toHaveBeenCalled();
    expect(api.getSession).not.toHaveBeenCalled();
    expect(createChargeSocket).not.toHaveBeenCalled();

    view.rerender(
      <ChargingStatus
        orderId="ord_1"
        accessToken="hydrated-order-token"
        api={api}
      />,
    );

    await waitFor(() =>
      expect(api.getOrder).toHaveBeenCalledWith(
        "ord_1",
        "hydrated-order-token",
      ),
    );
    await waitFor(() => expect(createChargeSocket).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(api.getSession).toHaveBeenCalledWith(
        "ses_1",
        "hydrated-order-token",
      ),
    );
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
      listeners.get("device.updated")?.({
        estimatedRemainingSeconds: 0,
        operationalWarning: "DEVICE_OFFLINE",
        type: "HEARTBEAT",
      });
    });
    expect(screen.getByText("0m 0s")).toBeVisible();
    expect(screen.getByText("DEVICE_OFFLINE")).toBeVisible();
    await act(async () => {
      listeners.get("session.updated")?.("COMPLETED");
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
      retryStart: vi.fn(),
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

  it("retries a failed start with its session capability", async () => {
    const user = userEvent.setup();
    const socket = {
      connected: false,
      disconnect: vi.fn(),
      emit: vi.fn(),
      off: vi.fn(),
      on: vi.fn(),
    };
    const api = {
      getOrder: vi.fn().mockResolvedValue({
        amountVnd: 5000,
        connectorCode: "ST01-C01",
        currency: "VND",
        durationMinutes: 60,
        id: "ord_1",
        payment: { provider: "PAYOS", status: "PAID" },
        sessionId: "ses_1",
        status: "PAID",
      }),
      getSession: vi.fn().mockResolvedValue({
        estimatedRemainingSeconds: null,
        id: "ses_1",
        lastDeviceEventAt: null,
        operationalWarning: null,
        orderId: "ord_1",
        status: "START_FAILED",
        timerAuthority: "DEVICE",
      }),
      retryStart: vi.fn().mockResolvedValue({ accepted: true }),
      stopSession: vi.fn(),
    };

    render(
      <ChargingStatus
        orderId="ord_1"
        accessToken="retry-capability"
        api={api}
        socket={socket}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Retry charging start" }),
    );

    expect(api.retryStart).toHaveBeenCalledWith("ses_1", "retry-capability");
  });

  it("does not expose retry when the device has not reported a start failure", async () => {
    const user = userEvent.setup();
    const api = {
      getOrder: vi.fn().mockResolvedValue({
        amountVnd: 5000,
        connectorCode: "ST01-C01",
        currency: "VND",
        durationMinutes: 60,
        id: "ord_1",
        payment: { provider: "PAYOS", status: "PAID" },
        sessionId: "ses_1",
        status: "PAID",
      }),
      getSession: vi.fn().mockResolvedValue({
        estimatedRemainingSeconds: null,
        id: "ses_1",
        lastDeviceEventAt: null,
        operationalWarning: null,
        orderId: "ord_1",
        status: "DEVICE_OFFLINE",
        timerAuthority: "DEVICE",
      }),
      retryStart: vi.fn(),
      stopSession: vi.fn().mockResolvedValue({ accepted: true }),
    };

    render(
      <ChargingStatus
        orderId="ord_1"
        accessToken="capability-token"
        api={api}
        socket={{
          connected: false,
          disconnect: vi.fn(),
          emit: vi.fn(),
          off: vi.fn(),
          on: vi.fn(),
        }}
      />,
    );

    await screen.findByText("DEVICE_OFFLINE");
    expect(
      screen.queryByRole("button", { name: "Retry charging start" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Stop charging" }),
    );
    expect(api.stopSession).toHaveBeenCalledWith(
      "ses_1",
      "capability-token",
    );
  });

  it("removes retry access when its session capability is unavailable", async () => {
    const api = {
      getOrder: vi.fn().mockResolvedValue({
        amountVnd: 5000,
        connectorCode: "ST01-C01",
        currency: "VND",
        durationMinutes: 60,
        id: "ord_1",
        payment: { provider: "PAYOS", status: "PAID" },
        sessionId: "ses_1",
        status: "PAID",
      }),
      getSession: vi.fn().mockResolvedValue({
        estimatedRemainingSeconds: null,
        id: "ses_1",
        lastDeviceEventAt: null,
        operationalWarning: null,
        orderId: "ord_1",
        status: "START_FAILED",
        timerAuthority: "DEVICE",
      }),
      retryStart: vi.fn(),
      stopSession: vi.fn(),
    };
    const socket = {
      connected: false,
      disconnect: vi.fn(),
      emit: vi.fn(),
      off: vi.fn(),
      on: vi.fn(),
    };
    const view = render(
      <ChargingStatus
        orderId="ord_1"
        accessToken="retry-capability"
        api={api}
        socket={socket}
      />,
    );

    await screen.findByRole("button", { name: "Retry charging start" });

    view.rerender(
      <ChargingStatus orderId="ord_1" api={api} socket={socket} />,
    );

    expect(
      screen.queryByRole("button", { name: "Retry charging start" }),
    ).not.toBeInTheDocument();
  });

  it("prevents duplicate retry clicks while a retry is pending", async () => {
    const user = userEvent.setup();
    let resolveRetry: (() => void) | undefined;
    const retryPromise = new Promise<{ accepted: true }>((resolve) => {
      resolveRetry = () => resolve({ accepted: true });
    });
    const api = {
      getOrder: vi.fn().mockResolvedValue({
        amountVnd: 5000,
        connectorCode: "ST01-C01",
        currency: "VND",
        durationMinutes: 60,
        id: "ord_1",
        payment: { provider: "PAYOS", status: "PAID" },
        sessionId: "ses_1",
        status: "PAID",
      }),
      getSession: vi.fn().mockResolvedValue({
        estimatedRemainingSeconds: null,
        id: "ses_1",
        lastDeviceEventAt: null,
        operationalWarning: null,
        orderId: "ord_1",
        status: "START_FAILED",
        timerAuthority: "DEVICE",
      }),
      retryStart: vi.fn().mockReturnValue(retryPromise),
      stopSession: vi.fn(),
    };

    render(
      <ChargingStatus
        orderId="ord_1"
        accessToken="retry-capability"
        api={api}
        socket={{
          connected: false,
          disconnect: vi.fn(),
          emit: vi.fn(),
          off: vi.fn(),
          on: vi.fn(),
        }}
      />,
    );

    const button = await screen.findByRole("button", {
      name: "Retry charging start",
    });
    await user.click(button);

    expect(api.retryStart).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Retrying start" }),
    ).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Retrying start" }));
    expect(api.retryStart).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRetry?.();
      await retryPromise;
    });
  });

  it("shows retry errors from the station", async () => {
    const user = userEvent.setup();
    const api = {
      getOrder: vi.fn().mockResolvedValue({
        amountVnd: 5000,
        connectorCode: "ST01-C01",
        currency: "VND",
        durationMinutes: 60,
        id: "ord_1",
        payment: { provider: "PAYOS", status: "PAID" },
        sessionId: "ses_1",
        status: "PAID",
      }),
      getSession: vi.fn().mockResolvedValue({
        estimatedRemainingSeconds: null,
        id: "ses_1",
        lastDeviceEventAt: null,
        operationalWarning: null,
        orderId: "ord_1",
        status: "START_FAILED",
        timerAuthority: "DEVICE",
      }),
      retryStart: vi.fn().mockRejectedValue(new Error("Connector is not available")),
      stopSession: vi.fn(),
    };

    render(
      <ChargingStatus
        orderId="ord_1"
        accessToken="retry-capability"
        api={api}
        socket={{
          connected: false,
          disconnect: vi.fn(),
          emit: vi.fn(),
          off: vi.fn(),
          on: vi.fn(),
        }}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Retry charging start" }),
    );

    expect(await screen.findByText("Connector is not available")).toBeVisible();
  });
});
