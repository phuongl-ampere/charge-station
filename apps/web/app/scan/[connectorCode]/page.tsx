"use client";

import { AlertTriangle, ArrowLeft, CircleCheck, PlugZap } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { DurationPicker } from "../../../components/DurationPicker";
import { PaymentPending } from "../../../components/PaymentPending";
import { PayosCheckout } from "../../../components/PayosCheckout";
import {
  chargeApi,
  type CheckoutOrder,
  type Connector,
} from "../../../lib/api";

export default function ScanConnectorPage() {
  const params = useParams<{ connectorCode: string }>();
  const router = useRouter();
  const connectorCode = decodeURIComponent(params.connectorCode);
  const [connector, setConnector] = useState<Connector | null>(null);
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [checkout, setCheckout] = useState<CheckoutOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [recoveringPaymentLink, setRecoveringPaymentLink] = useState(false);

  useEffect(() => {
    let active = true;
    void chargeApi
      .getConnector(connectorCode)
      .then((result) => {
        if (!active) return;
        setConnector(result);
        setDurationMinutes(result.allowedDurationsMinutes.at(0) ?? 60);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error ? cause.message : "Connector is unavailable",
          );
      });
    return () => {
      active = false;
    };
  }, [connectorCode]);

  async function createOrder(): Promise<void> {
    setCreating(true);
    setError(null);
    try {
      const result = await chargeApi.createOrder({
        connectorCode,
        durationMinutes,
      });
      const accessToken = result.realtimeAccessToken;
      if (accessToken) {
        window.sessionStorage.setItem(
          `charge-token:${result.orderId}`,
          accessToken,
        );
      }
      setCheckout(result);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to create a payment link",
      );
    } finally {
      setCreating(false);
    }
  }

  async function recoverPaymentLink(): Promise<void> {
    const pendingCheckout = checkout;
    const accessToken = pendingCheckout?.realtimeAccessToken;
    if (
      !pendingCheckout ||
      pendingCheckout.payment.checkoutUrl ||
      !accessToken
    ) {
      return;
    }

    setRecoveringPaymentLink(true);
    setError(null);
    try {
      const payment = await chargeApi.getPaymentLink(
        pendingCheckout.orderId,
        accessToken,
      );
      setCheckout((currentCheckout) =>
        currentCheckout?.orderId === pendingCheckout.orderId
          ? { ...currentCheckout, payment }
          : currentCheckout,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to recover the payment link",
      );
    } finally {
      setRecoveringPaymentLink(false);
    }
  }

  function viewStatus(): void {
    if (checkout)
      router.push(`/charge/${encodeURIComponent(checkout.orderId)}`);
  }

  const available = connector?.status === "AVAILABLE";

  return (
    <main className="scan-shell">
      <Link className="back-link" href="/">
        <ArrowLeft size={16} /> Connector access
      </Link>
      <section className="station-strip" aria-label="Station connector">
        <div className="station-symbol" aria-hidden="true">
          <PlugZap size={24} />
        </div>
        <div>
          <p className="eyebrow">
            {connector?.stationCode ?? "Reading station"}
          </p>
          <h1>{connectorCode}</h1>
        </div>
        <span
          className={`availability ${available ? "is-available" : "is-unavailable"}`}
        >
          {available ? <CircleCheck size={15} /> : <AlertTriangle size={15} />}
          {connector?.status ?? "CHECKING"}
        </span>
      </section>

      {error && (
        <p className="page-error" role="alert">
          {error}
        </p>
      )}
      {!connector && !error && (
        <p className="loading-line">Reading connector availability...</p>
      )}
      {connector && (
        <div className="scan-workspace">
          <DurationPicker
            durations={connector.allowedDurationsMinutes}
            hourlyPriceVnd={connector.hourlyPriceVnd}
            onSelect={setDurationMinutes}
            disabled={!available || Boolean(checkout)}
          />
          {!checkout && (
            <section className="order-action">
              <p>
                Price and availability are confirmed by the local station
                service.
              </p>
              <button
                className="primary-button"
                type="button"
                disabled={!available || creating}
                onClick={createOrder}
              >
                {creating ? "Creating payment link" : "Create payment link"}
              </button>
            </section>
          )}
          {checkout?.payment.checkoutUrl && (
            <PayosCheckout
              checkoutUrl={checkout.payment.checkoutUrl}
              amount={checkout.amount}
              currency={checkout.currency}
              onViewStatus={viewStatus}
            />
          )}
          {checkout && !checkout.payment.checkoutUrl && (
            <PaymentPending
              amount={checkout.amount}
              currency={checkout.currency}
              disabled={!checkout.realtimeAccessToken}
              refreshing={recoveringPaymentLink}
              onRefresh={recoverPaymentLink}
              onViewStatus={viewStatus}
            />
          )}
        </div>
      )}
    </main>
  );
}
