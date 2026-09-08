export const PAYOS_PROVIDER = "PAYOS" as const;

export type PaymentStatus =
  "PENDING_PAYMENT" | "PAID" | "PAYMENT_FAILED" | "EXPIRED" | "REFUNDED";

export type PaymentTransactionStatus =
  "PENDING" | "PAID" | "FAILED" | "EXPIRED";

export interface PayosWebhookData {
  orderCode: number | string;
  amount: number;
  paymentLinkId?: string;
  status?: string;
  [key: string]: string | number | boolean | null | undefined;
}

export interface PayosWebhook {
  code: string;
  desc?: string;
  success: boolean;
  data: PayosWebhookData;
  signature: string;
}

export interface CreatePaymentLinkInput {
  orderCode: number;
  amount: number;
  description: string;
  returnUrl: string;
  cancelUrl: string;
}

export interface PaymentLink {
  checkoutUrl: string;
  paymentLinkId: string;
}
