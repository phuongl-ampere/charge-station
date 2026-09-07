export const PAYOS_PROVIDER = 'PAYOS' as const;

export type PaymentStatus =
  | 'PENDING_PAYMENT'
  | 'PAID'
  | 'PAYMENT_FAILED'
  | 'EXPIRED'
  | 'REFUNDED';

export type PaymentTransactionStatus = 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED';

export interface PayosWebhook {
  code: string;
  desc: string;
  success: boolean;
  data: Record<string, string | number | boolean | null>;
  signature: string;
}

export interface CreatePaymentLinkInput {
  orderCode: number;
  amountVnd: number;
  description: string;
  returnUrl: string;
  cancelUrl: string;
}

export interface PaymentLink {
  checkoutUrl: string;
  paymentLinkId: string;
}
