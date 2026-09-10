import { afterEach, describe, expect, it, vi } from "vitest";

import { createChargeApi } from "./api";

const localApiOrigin = "http://localhost:4000";

function mockOrderResponse(checkoutUrl: string) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      orderId: "ord_1",
      amount: 10000,
      currency: "VND",
      payment: {
        provider: "PAYOS",
        checkoutUrl,
      },
    }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("retryStart", () => {
  it("posts the session capability to the local retry endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accepted: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createChargeApi(localApiOrigin).retryStart(
        "session/with spaces",
        "capability-token",
      ),
    ).resolves.toEqual({ accepted: true });

    expect(fetchMock).toHaveBeenCalledWith(
      `${localApiOrigin}/sessions/session%2Fwith%20spaces/retry-start`,
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer capability-token",
        },
      }),
    );
  });
});

describe("encrypted station QR scan", () => {
  it("requests the opaque token path without exposing a station code", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        stationName: "Riverside Station",
        connectors: [
          {
            connectorCode: "ST01-C01",
            status: "AVAILABLE",
            allowedDurationsMinutes: [60, 120],
            hourlyPriceVnd: 5000,
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createChargeApi(localApiOrigin).getStationScan("ZX5fY2lwaGVydGV4dA"),
    ).resolves.toMatchObject({
      stationName: "Riverside Station",
      connectors: [expect.objectContaining({ connectorCode: "ST01-C01" })],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `${localApiOrigin}/public/stations/scan/ZX5fY2lwaGVydGV4dA`,
      expect.objectContaining({ headers: {} }),
    );
  });
});

describe("createOrder checkout URL validation", () => {
  it("keeps an ambiguous payment response usable without a checkout URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        orderId: "ord_1",
        amount: 10000,
        currency: "VND",
        payment: {
          provider: "PAYOS",
          paymentPending: true,
        },
        realtimeAccessToken: "order-capability",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createChargeApi(localApiOrigin).createOrder({
        connectorCode: "ST01-C01",
        durationMinutes: 120,
      }),
    ).resolves.toMatchObject({
      orderId: "ord_1",
      payment: { provider: "PAYOS", paymentPending: true },
      realtimeAccessToken: "order-capability",
    });
  });

  it("accepts a local mock checkout under the validated local API origin", async () => {
    mockOrderResponse(
      `${localApiOrigin}/payments/payos/mock/123?returnUrl=%2Fcharge%2Ford_1`,
    );

    const order = await createChargeApi(localApiOrigin).createOrder({
      connectorCode: "ST01-C01",
      durationMinutes: 120,
    });

    expect(order.payment.checkoutUrl).toBe(
      `${localApiOrigin}/payments/payos/mock/123?returnUrl=%2Fcharge%2Ford_1`,
    );
  });

  it("accepts a live PayOS checkout at the exact trusted host", async () => {
    mockOrderResponse("https://pay.payos.vn:443/web/abc123");

    const order = await createChargeApi(localApiOrigin).createOrder({
      connectorCode: "ST01-C01",
      durationMinutes: 120,
    });

    expect(order.payment.checkoutUrl).toBe("https://pay.payos.vn/web/abc123");
  });

  it.each([
    "http://pay.payos.vn/web/abc123",
    "https://pay.payos.vn:8443/web/abc123",
    "https://pay.payos.vn.evil.example/web/abc123",
    "https://evil.example/payos/checkout",
    "https://attacker@pay.payos.vn/web/abc123",
    "https://pay.payos.vn@evil.example/web/abc123",
    `${localApiOrigin.replace(":4000", ":4001")}/payments/payos/mock/123`,
  ])("rejects unsafe checkout URL %s", async (checkoutUrl) => {
    mockOrderResponse(checkoutUrl);

    await expect(
      createChargeApi(localApiOrigin).createOrder({
        connectorCode: "ST01-C01",
        durationMinutes: 120,
      }),
    ).rejects.toThrow("Invalid checkout URL");
  });
});

describe("payment-link recovery", () => {
  it("uses the order capability and validates a recovered checkout URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        provider: "PAYOS",
        checkoutUrl: localApiOrigin + "/payments/payos/mock/123",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = createChargeApi(localApiOrigin) as unknown as {
      getPaymentLink(
        orderId: string,
        accessToken: string,
      ): Promise<{
        provider: "PAYOS";
        checkoutUrl?: string;
        paymentPending?: true;
      }>;
    };

    await expect(
      Promise.resolve().then(() =>
        api.getPaymentLink("order/with spaces", "capability-token"),
      ),
    ).resolves.toEqual({
      provider: "PAYOS",
      checkoutUrl: localApiOrigin + "/payments/payos/mock/123",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      localApiOrigin + "/orders/order%2Fwith%20spaces/payment-link",
      {
        headers: { authorization: "Bearer capability-token" },
      },
    );
  });

  it("rejects an unsafe recovered checkout URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        provider: "PAYOS",
        checkoutUrl: "https://pay.payos.vn.evil.example/web/abc123",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = createChargeApi(localApiOrigin) as unknown as {
      getPaymentLink(
        orderId: string,
        accessToken: string,
      ): Promise<{
        provider: "PAYOS";
        checkoutUrl?: string;
        paymentPending?: true;
      }>;
    };

    await expect(
      Promise.resolve().then(() =>
        api.getPaymentLink("ord_1", "capability-token"),
      ),
    ).rejects.toThrow("Invalid checkout URL");
  });
});
