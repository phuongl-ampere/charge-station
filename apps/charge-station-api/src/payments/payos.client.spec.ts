import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PayosClient,
  PayosPaymentLinkAmbiguousError,
  PayosPaymentLinkDefinitiveError,
} from "./payos.client.js";

const payosEnvironmentKeys = [
  "PAYOS_MODE",
  "PAYOS_CLIENT_ID",
  "PAYOS_API_KEY",
  "PAYOS_CHECKSUM_KEY",
  "PAYOS_RETURN_URL",
  "PAYOS_CANCEL_URL",
  "PAYOS_REQUEST_TIMEOUT_MS",
] as const;
const originalPayosEnvironment = new Map(
  payosEnvironmentKeys.map((key) => [key, process.env[key]]),
);

describe("PayosClient mock provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of originalPayosEnvironment) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it.each([
    ["missing mode", undefined],
    ["an unsupported mode", "test"],
  ])("rejects %s instead of silently enabling mock payments", (_name, mode) => {
    if (mode === undefined) {
      delete process.env.PAYOS_MODE;
    } else {
      process.env.PAYOS_MODE = mode;
    }
    process.env.PAYOS_CLIENT_ID = "client-id";
    process.env.PAYOS_API_KEY = "api-key";
    process.env.PAYOS_CHECKSUM_KEY = "checksum-key";
    process.env.PAYOS_RETURN_URL = "https://example.test/return";
    process.env.PAYOS_CANCEL_URL = "https://example.test/cancel";

    expect(() => new PayosClient()).toThrow("PAYOS_MODE must be mock or live");
  });

  it("rejects live mode without explicit credentials", () => {
    process.env.PAYOS_MODE = "live";
    delete process.env.PAYOS_CLIENT_ID;
    delete process.env.PAYOS_API_KEY;
    delete process.env.PAYOS_CHECKSUM_KEY;
    process.env.PAYOS_RETURN_URL = "https://example.test/return";
    process.env.PAYOS_CANCEL_URL = "https://example.test/cancel";

    expect(() => new PayosClient()).toThrow("PAYOS_CLIENT_ID must be configured");
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

  it("classifies a provider 4xx rejection as definitive", async () => {
    vi.spyOn(axios, "post").mockRejectedValue(
      Object.assign(new Error("invalid request"), {
        isAxiosError: true,
        response: { status: 422 },
      }),
    );
    const client = createLiveClient();

    await expect(client.createPaymentLink(createInput())).rejects.toBeInstanceOf(
      PayosPaymentLinkDefinitiveError,
    );
    await expect(client.createPaymentLink(createInput())).rejects.toMatchObject({
      classification: "DEFINITIVE",
      httpStatus: 422,
    });
  });

  it("classifies a provider timeout and 5xx response as ambiguous", async () => {
    const post = vi.spyOn(axios, "post");
    post.mockRejectedValueOnce(
      Object.assign(new Error("timeout"), {
        isAxiosError: true,
        code: "ECONNABORTED",
      }),
    );
    post.mockRejectedValueOnce(
      Object.assign(new Error("unavailable"), {
        isAxiosError: true,
        response: { status: 503 },
      }),
    );
    const client = createLiveClient();

    await expect(client.createPaymentLink(createInput())).rejects.toBeInstanceOf(
      PayosPaymentLinkAmbiguousError,
    );
    await expect(client.createPaymentLink(createInput())).rejects.toMatchObject({
      classification: "AMBIGUOUS",
      httpStatus: 503,
    });
  });

  it.each([
    ["uses the default when unset", undefined, 10_000],
    ["clamps a too-small value", "1", 1_000],
    ["uses a configured value", "7500", 7_500],
    ["clamps a too-large value", "60001", 60_000],
  ])(
    "%s for a live creation request",
    async (_label, timeoutValue, expectedTimeout) => {
      process.env.PAYOS_MODE = "live";
      process.env.PAYOS_CLIENT_ID = "client-id";
      process.env.PAYOS_API_KEY = "api-key";
      process.env.PAYOS_CHECKSUM_KEY = "checksum-key";
      process.env.PAYOS_RETURN_URL = "https://example.test/return";
      process.env.PAYOS_CANCEL_URL = "https://example.test/cancel";
      if (timeoutValue === undefined) {
        delete process.env.PAYOS_REQUEST_TIMEOUT_MS;
      } else {
        process.env.PAYOS_REQUEST_TIMEOUT_MS = timeoutValue;
      }
      const post = vi.spyOn(axios, "post").mockResolvedValue({
        data: {
          code: "00",
          data: {
            checkoutUrl: "https://pay.example/100001",
            paymentLinkId: "pl_100001",
          },
        },
      } as never);

      await expect(
        new PayosClient().createPaymentLink(createInput()),
      ).resolves.toMatchObject({
        checkoutUrl: "https://pay.example/100001",
      });

      expect(post).toHaveBeenCalledWith(
        "https://api-merchant.payos.vn/v2/payment-requests",
        expect.any(Object),
        expect.objectContaining({ timeout: expectedTimeout }),
      );
    },
  );

  it("classifies a malformed successful creation response as definitive", async () => {
    vi.spyOn(axios, "post").mockResolvedValue({
      data: {
        code: "00",
        data: { checkoutUrl: "https://pay.example/100001" },
      },
    } as never);
    const client = createLiveClient();

    await expect(client.createPaymentLink(createInput())).rejects.toBeInstanceOf(
      PayosPaymentLinkDefinitiveError,
    );
    await expect(client.createPaymentLink(createInput())).rejects.toMatchObject({
      classification: "DEFINITIVE",
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

  it("cancels a deterministic local checkout without a network request", async () => {
    const client = new PayosClient({
      mode: "mock",
      clientId: "client-id",
      apiKey: "api-key",
      checksumKey: "checksum-key",
      returnUrl: "http://localhost:5173/charge/return",
      cancelUrl: "http://localhost:5173/charge/cancel",
    });
    const post = vi.spyOn(axios, "post");

    await expect(client.cancelPaymentLink(100001)).resolves.toBeUndefined();

    expect(post).not.toHaveBeenCalled();
  });

  it("reports a deterministic pending status for a local checkout", async () => {
    const client = new PayosClient({
      mode: "mock",
      clientId: "client-id",
      apiKey: "api-key",
      checksumKey: "checksum-key",
      returnUrl: "http://localhost:5173/charge/return",
      cancelUrl: "http://localhost:5173/charge/cancel",
    });
    const statusClient = client as unknown as {
      getPaymentLinkStatus(orderCode: number): Promise<unknown>;
    };

    await expect(statusClient.getPaymentLinkStatus(100001)).resolves.toEqual({
      status: "PENDING",
      paymentLinkId: "mock_100001",
    });
  });

  it("reads a definitive paid status from a live payment-link lookup", async () => {
    const get = vi.spyOn(axios, "get").mockResolvedValue({
      data: {
        code: "00",
        data: {
          amount: 10000,
          paymentLinkId: "pl_100001",
          status: "PAID",
        },
      },
    } as never);
    const statusClient = createLiveClient() as unknown as {
      getPaymentLinkStatus(orderCode: number): Promise<unknown>;
    };

    await expect(statusClient.getPaymentLinkStatus(100001)).resolves.toEqual({
      status: "PAID",
      amount: 10000,
      paymentLinkId: "pl_100001",
    });
    expect(get).toHaveBeenCalledWith(
      "https://api-merchant.payos.vn/v2/payment-requests/100001",
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it("uses PayOS client credentials when cancelling a live payment link", async () => {
    const post = vi.spyOn(axios, "post").mockResolvedValue({} as never);

    await expect(
      createLiveClient().cancelPaymentLink(100001),
    ).resolves.toBeUndefined();

    expect(post).toHaveBeenCalledWith(
      "https://api-merchant.payos.vn/v2/payment-requests/100001/cancel",
      undefined,
      {
        headers: {
          "x-client-id": "client-id",
          "x-api-key": "api-key",
          "content-type": "application/json",
        },
        timeout: 10_000,
      },
    );
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
        timeout: 10_000,
      },
    );
  });

  it("classifies a timed-out live payment-link lookup as ambiguous", async () => {
    vi.spyOn(axios, "get").mockRejectedValue(
      Object.assign(new Error("timeout"), {
        isAxiosError: true,
        code: "ECONNABORTED",
      }),
    );

    await expect(
      createLiveClient().getPaymentLinkInfo(100001),
    ).rejects.toMatchObject({
      classification: "AMBIGUOUS",
    });
  });
});

function createLiveClient(): PayosClient {
  return new PayosClient({
    mode: "live",
    clientId: "client-id",
    apiKey: "api-key",
    checksumKey: "checksum-key",
    returnUrl: "https://example.test/return",
    cancelUrl: "https://example.test/cancel",
  });
}

function createInput() {
  return {
    amount: 10000,
    orderCode: 100001,
    description: "Charge ST01C01 2h        ",
    returnUrl: "https://example.test/return",
    cancelUrl: "https://example.test/cancel",
  };
}
