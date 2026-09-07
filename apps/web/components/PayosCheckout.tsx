"use client";

import { ArrowUpRight, QrCode } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

interface PayosCheckoutProps {
  checkoutUrl: string;
  amount: number;
  currency: string;
  onViewStatus: () => void;
}

export function PayosCheckout({
  checkoutUrl,
  amount,
  currency,
  onViewStatus,
}: PayosCheckoutProps) {
  function openCheckout(): void {
    window.open(checkoutUrl, "_blank", "noopener,noreferrer");
  }

  return (
    <section className="checkout-panel" aria-labelledby="checkout-heading">
      <div className="section-heading">
        <span className="section-icon" aria-hidden="true">
          <QrCode size={16} strokeWidth={2} />
        </span>
        <div>
          <p className="eyebrow">Payment link ready</p>
          <h2 id="checkout-heading">Scan or open checkout</h2>
        </div>
      </div>
      <div className="checkout-content">
        <div className="qr-frame" aria-label="PayOS checkout QR code">
          <QRCodeSVG value={checkoutUrl} size={176} level="M" includeMargin />
        </div>
        <div className="checkout-actions">
          <p className="checkout-amount">
            {new Intl.NumberFormat("en-US").format(amount)} {currency}
          </p>
          <p className="quiet-copy">
            Payment confirmation is verified by the station before charging
            starts.
          </p>
          <div className="action-row">
            <button
              className="icon-button"
              type="button"
              onClick={openCheckout}
              aria-label="Open PayOS checkout"
              title="Open PayOS checkout"
            >
              <ArrowUpRight size={18} />
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
      </div>
    </section>
  );
}
