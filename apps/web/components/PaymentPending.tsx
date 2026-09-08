"use client";

import { RefreshCw } from "lucide-react";

interface PaymentPendingProps {
  amount: number;
  currency: string;
  disabled?: boolean;
  refreshing?: boolean;
  onRefresh: () => void;
  onViewStatus: () => void;
}

export function PaymentPending({
  amount,
  currency,
  disabled = false,
  refreshing = false,
  onRefresh,
  onViewStatus,
}: PaymentPendingProps) {
  return (
    <section className="checkout-panel" aria-labelledby="pending-payment-heading">
      <div className="section-heading">
        <span className="section-icon" aria-hidden="true">
          <RefreshCw size={16} strokeWidth={2} />
        </span>
        <div>
          <p className="eyebrow">Payment request pending</p>
          <h2 id="pending-payment-heading">Payment link pending</h2>
        </div>
      </div>
      <div className="payment-pending-content">
        <p className="checkout-amount">
          {new Intl.NumberFormat("en-US").format(amount)} {currency}
        </p>
        <p className="quiet-copy">
          The station is confirming your payment link. Check again when it is
          ready.
        </p>
        <div className="action-row">
          <button
            className="primary-button payment-refresh-button"
            type="button"
            disabled={disabled || refreshing}
            onClick={onRefresh}
          >
            <RefreshCw size={17} aria-hidden="true" />
            {refreshing ? "Checking payment link" : "Check payment link"}
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={onViewStatus}
          >
            View charging status
          </button>
        </div>
      </div>
    </section>
  );
}
