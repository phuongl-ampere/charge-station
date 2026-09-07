import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PayosClient } from "./payos.client.js";

describe("PayosClient mock provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a deterministic local checkout without a network request", async () => {
    const client = new PayosClient({
      mode: "mock",
      clientId: "client-id",
      apiKey: "api-key",
      checksumKey: "checksum-key",
      returnUrl: "http://localhost:5173/charge/return",
      cancelUrl: "http://localhost:5173/charge/cancel",
    });

    await expect(
      client.createPaymentLink({
        amount: 10000,
        orderCode: 100001,
        description: "Charge ST01C01 2h        ",
        returnUrl: "http://localhost:5173/charge/return",
        cancelUrl: "http://localhost:5173/charge/cancel",
      }),
    ).resolves.toEqual({
      checkoutUrl: "http://localhost:4000/payments/payos/mock/100001",
      paymentLinkId: "mock_100001",
    });
  });

  it("signs a local webhook fixture that it can verify", () => {
    const client = new PayosClient({
      mode: "mock",
      clientId: "client-id",
      apiKey: "api-key",
      checksumKey: "checksum-key",
      returnUrl: "http://localhost:5173/charge/return",
      cancelUrl: "http://localhost:5173/charge/cancel",
    });
    const data = {
      amount: 10000,
      orderCode: 100001,
      paymentLinkId: "mock_100001",
      status: "PAID",
    };

    expect(client.verifyWebhook(data, client.signWebhook(data))).toBe(true);
  });

  it("looks up a deterministic local checkout without a network request", async () => {
    const client = new PayosClient({
      mode: "mock",
      clientId: "client-id",
      apiKey: "api-key",
      checksumKey: "checksum-key",
      returnUrl: "http://localhost:5173/charge/return",
      cancelUrl: "http://localhost:5173/charge/cancel",
    });
    const get = vi.spyOn(axios, "get");
    const recoveryClient = client as unknown as {
      getPaymentLinkInfo(orderCode: number): Promise<{
        checkoutUrl: string;
        paymentLinkId: string;
      }>;
    };

    await expect(recoveryClient.getPaymentLinkInfo(100001)).resolves.toEqual({
      checkoutUrl: "http://localhost:4000/payments/payos/mock/100001",
      paymentLinkId: "mock_100001",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("uses PayOS client credentials when looking up a live payment link", async () => {
    const get = vi.spyOn(axios, "get").mockResolvedValue({
      data: {
        code: "00",
        data: {
          checkoutUrl: "https://pay.example/100001",
          paymentLinkId: "pl_100001",
        },
      },
    } as never);
    const client = new PayosClient({
      mode: "live",
      clientId: "client-id",
      apiKey: "api-key",
      checksumKey: "checksum-key",
      returnUrl: "https://example.test/return",
      cancelUrl: "https://example.test/cancel",
    });
    const recoveryClient = client as unknown as {
      getPaymentLinkInfo(orderCode: number): Promise<{
        checkoutUrl: string;
        paymentLinkId: string;
      }>;
    };

    await expect(recoveryClient.getPaymentLinkInfo(100001)).resolves.toEqual({
      checkoutUrl: "https://pay.example/100001",
      paymentLinkId: "pl_100001",
    });
    expect(get).toHaveBeenCalledWith(
      "https://api-merchant.payos.vn/v2/payment-requests/100001",
      {
        headers: {
          "x-client-id": "client-id",
          "x-api-key": "api-key",
          "content-type": "application/json",
        },
      },
    );
  });
});
