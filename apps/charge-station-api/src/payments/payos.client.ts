import axios from "axios";
import type {
  CreatePaymentLinkInput,
  PaymentLink,
  PayosWebhook,
  PayosWebhookData,
} from "@charge-station/contracts";

import {
  buildPayosSignature,
  verifyPayosSignature,
} from "./payos-signature.js";

export type {
  CreatePaymentLinkInput,
  PaymentLink,
  PayosWebhook,
  PayosWebhookData,
} from "@charge-station/contracts";

export type PayosMode = "live" | "mock";

export interface PayosClientConfig {
  mode: PayosMode;
  clientId: string;
  apiKey: string;
  checksumKey: string;
  returnUrl: string;
  cancelUrl: string;
  mockCheckoutBaseUrl?: string;
}

interface PayosPaymentLinkResponse {
  code: string;
  data?: {
    checkoutUrl?: string;
    paymentLinkId?: string;
  };
}

const PAYOS_PAYMENT_REQUEST_URL =
  "https://api-merchant.payos.vn/v2/payment-requests";

export class PayosClient {
  constructor(private readonly config: PayosClientConfig = readPayosConfig()) {}

  get returnUrl(): string {
    return this.config.returnUrl;
  }

  get cancelUrl(): string {
    return this.config.cancelUrl;
  }

  get isMock(): boolean {
    return this.config.mode === "mock";
  }

  async createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLink> {
    const amount = Math.round(input.amount);
    this.validatePaymentLinkInput({ ...input, amount });

    if (this.config.mode === "mock") {
      const checkoutBaseUrl =
        this.config.mockCheckoutBaseUrl ??
        `http://localhost:${process.env.PORT ?? 4000}`;

      return {
        checkoutUrl: `${checkoutBaseUrl}/payments/payos/mock/${input.orderCode}`,
        paymentLinkId: `mock_${input.orderCode}`,
      };
    }

    const signature = buildPayosSignature(
      {
        amount,
        cancelUrl: input.cancelUrl,
        description: input.description,
        orderCode: input.orderCode,
        returnUrl: input.returnUrl,
      },
      this.config.checksumKey,
    );
    const response = await axios.post<PayosPaymentLinkResponse>(
      PAYOS_PAYMENT_REQUEST_URL,
      { ...input, amount, signature },
      {
        headers: {
          "x-client-id": this.config.clientId,
          "x-api-key": this.config.apiKey,
          "content-type": "application/json",
        },
      },
    );
    const checkoutUrl = response.data.data?.checkoutUrl;
    const paymentLinkId = response.data.data?.paymentLinkId;

    if (response.data.code !== "00" || !checkoutUrl || !paymentLinkId) {
      throw new Error("PayOS payment link creation failed");
    }

    return { checkoutUrl, paymentLinkId };
  }

  async getPaymentLinkInfo(orderCode: number): Promise<PaymentLink> {
    if (!Number.isSafeInteger(orderCode) || orderCode <= 0) {
      throw new Error("PayOS order code must be a positive safe integer");
    }

    if (this.config.mode === "mock") {
      const checkoutBaseUrl =
        this.config.mockCheckoutBaseUrl ??
        `http://localhost:${process.env.PORT ?? 4000}`;

      return {
        checkoutUrl: `${checkoutBaseUrl}/payments/payos/mock/${orderCode}`,
        paymentLinkId: `mock_${orderCode}`,
      };
    }

    const response = await axios.get<PayosPaymentLinkResponse>(
      `${PAYOS_PAYMENT_REQUEST_URL}/${orderCode}`,
      {
        headers: {
          "x-client-id": this.config.clientId,
          "x-api-key": this.config.apiKey,
          "content-type": "application/json",
        },
      },
    );
    const checkoutUrl = response.data.data?.checkoutUrl;
    const paymentLinkId = response.data.data?.paymentLinkId;

    if (response.data.code !== "00" || !checkoutUrl || !paymentLinkId) {
      throw new Error("PayOS payment link lookup failed");
    }

    return { checkoutUrl, paymentLinkId };
  }

  verifyWebhook(data: Record<string, unknown>, signature: string): boolean {
    return verifyPayosSignature(data, signature, this.config.checksumKey);
  }

  signWebhook(data: Record<string, unknown>): string {
    return buildPayosSignature(data, this.config.checksumKey);
  }

  private validatePaymentLinkInput(input: CreatePaymentLinkInput): void {
    if (!Number.isSafeInteger(input.orderCode) || input.orderCode <= 0) {
      throw new Error("PayOS order code must be a positive safe integer");
    }
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new Error("PayOS amount must be a positive whole VND amount");
    }
    if (!/^[\x20-\x7E]{25}$/.test(input.description)) {
      throw new Error("PayOS description must be exactly 25 ASCII characters");
    }
  }
}

function readPayosConfig(): PayosClientConfig {
  return {
    mode: process.env.PAYOS_MODE === "live" ? "live" : "mock",
    clientId: process.env.PAYOS_CLIENT_ID ?? "mock-client-id",
    apiKey: process.env.PAYOS_API_KEY ?? "mock-api-key",
    checksumKey: process.env.PAYOS_CHECKSUM_KEY ?? "mock-checksum-key",
    returnUrl:
      process.env.PAYOS_RETURN_URL ?? "http://localhost:5173/charge/return",
    cancelUrl:
      process.env.PAYOS_CANCEL_URL ?? "http://localhost:5173/charge/cancel",
    mockCheckoutBaseUrl: process.env.PAYOS_MOCK_CHECKOUT_BASE_URL,
  };
}
