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
  requestTimeoutMs?: number;
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
const DEFAULT_PAYOS_REQUEST_TIMEOUT_MS = 10_000;
const MIN_PAYOS_REQUEST_TIMEOUT_MS = 1_000;
const MAX_PAYOS_REQUEST_TIMEOUT_MS = 60_000;

interface PayosPaymentLinkErrorOptions {
  httpStatus?: number;
  cause?: unknown;
}

abstract class PayosPaymentLinkCreationError extends Error {
  abstract readonly classification: "DEFINITIVE" | "AMBIGUOUS";
  readonly httpStatus?: number;

  protected constructor(
    message: string,
    options: PayosPaymentLinkErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.httpStatus = options.httpStatus;
  }
}

export class PayosPaymentLinkDefinitiveError extends PayosPaymentLinkCreationError {
  readonly classification = "DEFINITIVE" as const;

  constructor(
    message: string,
    options: PayosPaymentLinkErrorOptions = {},
  ) {
    super(message, options);
  }
}

export class PayosPaymentLinkAmbiguousError extends PayosPaymentLinkCreationError {
  readonly classification = "AMBIGUOUS" as const;

  constructor(
    message: string,
    options: PayosPaymentLinkErrorOptions = {},
  ) {
    super(message, options);
  }
}

export class PayosClient {
  private readonly config: PayosClientConfig & { requestTimeoutMs: number };

  constructor(config: PayosClientConfig = readPayosConfig()) {
    this.config = {
      ...config,
      requestTimeoutMs: normalizeRequestTimeout(config.requestTimeoutMs),
    };
  }

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
    try {
      const response = await axios.post<PayosPaymentLinkResponse>(
        PAYOS_PAYMENT_REQUEST_URL,
        { ...input, amount, signature },
        {
          headers: {
            "x-client-id": this.config.clientId,
            "x-api-key": this.config.apiKey,
            "content-type": "application/json",
          },
          timeout: this.config.requestTimeoutMs,
        },
      );
      return readPaymentLink(
        response.data,
        "PayOS payment link creation failed",
      );
    } catch (error: unknown) {
      throw classifyPaymentLinkError(error, "creation");
    }
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

    try {
      const response = await axios.get<PayosPaymentLinkResponse>(
        `${PAYOS_PAYMENT_REQUEST_URL}/${orderCode}`,
        {
          headers: {
            "x-client-id": this.config.clientId,
            "x-api-key": this.config.apiKey,
            "content-type": "application/json",
          },
          timeout: this.config.requestTimeoutMs,
        },
      );
      return readPaymentLink(response.data, "PayOS payment link lookup failed");
    } catch (error: unknown) {
      throw classifyPaymentLinkError(error, "lookup");
    }
  }

  async cancelPaymentLink(orderCode: number): Promise<void> {
    if (!Number.isSafeInteger(orderCode) || orderCode <= 0) {
      throw new Error("PayOS order code must be a positive safe integer");
    }
    if (this.config.mode === "mock") {
      return;
    }

    await axios.post(
      `${PAYOS_PAYMENT_REQUEST_URL}/${orderCode}/cancel`,
      undefined,
      {
        headers: {
          "x-client-id": this.config.clientId,
          "x-api-key": this.config.apiKey,
          "content-type": "application/json",
        },
        timeout: this.config.requestTimeoutMs,
      },
    );
  }

  verifyWebhook(data: Record<string, unknown>, signature: string): boolean {
    return verifyPayosSignature(data, signature, this.config.checksumKey);
  }

  signWebhook(data: Record<string, unknown>): string {
    return buildPayosSignature(data, this.config.checksumKey);
  }

  private validatePaymentLinkInput(input: CreatePaymentLinkInput): void {
    if (!Number.isSafeInteger(input.orderCode) || input.orderCode <= 0) {
      throw new PayosPaymentLinkDefinitiveError(
        "PayOS order code must be a positive safe integer",
      );
    }
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new PayosPaymentLinkDefinitiveError(
        "PayOS amount must be a positive whole VND amount",
      );
    }
    if (!/^[\x20-\x7E]{25}$/.test(input.description)) {
      throw new PayosPaymentLinkDefinitiveError(
        "PayOS description must be exactly 25 ASCII characters",
      );
    }
  }
}

function classifyPaymentLinkError(
  error: unknown,
  operation: "creation" | "lookup",
): PayosPaymentLinkCreationError {
  if (error instanceof PayosPaymentLinkCreationError) {
    return error;
  }

  if (axios.isAxiosError(error)) {
    const httpStatus = error.response?.status;
    if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) {
      return new PayosPaymentLinkDefinitiveError(
        "PayOS payment link " + operation + " was rejected: " + httpStatus,
        { httpStatus, cause: error },
      );
    }
    return new PayosPaymentLinkAmbiguousError(
      "PayOS payment link " + operation + " outcome is ambiguous",
      { httpStatus, cause: error },
    );
  }

  return new PayosPaymentLinkAmbiguousError(
    "PayOS payment link " + operation + " outcome is ambiguous",
    { cause: error },
  );
}

function readPaymentLink(
  response: unknown,
  errorMessage: string,
): PaymentLink {
  if (!isPaymentLinkResponse(response)) {
    throw new PayosPaymentLinkDefinitiveError(errorMessage);
  }

  return response.data;
}

function isPaymentLinkResponse(
  value: unknown,
): value is { code: "00"; data: PaymentLink } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("code" in value) ||
    value.code !== "00" ||
    !("data" in value) ||
    typeof value.data !== "object" ||
    value.data === null ||
    !("checkoutUrl" in value.data) ||
    typeof value.data.checkoutUrl !== "string" ||
    !value.data.checkoutUrl ||
    !("paymentLinkId" in value.data) ||
    typeof value.data.paymentLinkId !== "string" ||
    !value.data.paymentLinkId
  ) {
    return false;
  }

  return true;
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
    requestTimeoutMs: readPayosRequestTimeout(),
  };
}

function readPayosRequestTimeout(): number | undefined {
  const rawValue = process.env.PAYOS_REQUEST_TIMEOUT_MS;
  if (rawValue === undefined || !/^\d+$/.test(rawValue)) {
    return undefined;
  }
  return Number(rawValue);
}

function normalizeRequestTimeout(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) {
    return DEFAULT_PAYOS_REQUEST_TIMEOUT_MS;
  }
  return Math.min(
    MAX_PAYOS_REQUEST_TIMEOUT_MS,
    Math.max(MIN_PAYOS_REQUEST_TIMEOUT_MS, Math.floor(value)),
  );
}
