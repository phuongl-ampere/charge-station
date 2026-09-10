"use client";

import {
  AlertTriangle,
  ArrowLeft,
  CircleCheck,
  PlugZap,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { DurationPicker } from "../../../../components/DurationPicker";
import { PaymentPending } from "../../../../components/PaymentPending";
import { PayosCheckout } from "../../../../components/PayosCheckout";
import {
  chargeApi,
  type CheckoutOrder,
  type StationScan,
} from "../../../../lib/api";

export default function StationScanPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const token = decodeURIComponent(params.token);
  const [station, setStation] = useState<StationScan | null>(null);
  const [selectedConnectorCode, setSelectedConnectorCode] = useState<
    string | null
  >(null);
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [checkout, setCheckout] = useState<CheckoutOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [recoveringPaymentLink, setRecoveringPaymentLink] = useState(false);

  useEffect(() => {
    let active = true;
    void chargeApi
      .getStationScan(token)
      .then((result) => {
        if (!active) return;
        const firstAvailableConnector = result.connectors.find(
          (connector) => connector.status === "AVAILABLE",
        );
        setStation(result);
        setSelectedConnectorCode(
          firstAvailableConnector?.connectorCode ?? null,
        );
        setDurationMinutes(
          firstAvailableConnector?.allowedDurationsMinutes.at(0) ?? 60,
        );
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Station QR is unavailable",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [token]);

  const selectedConnector = station?.connectors.find(
    (connector) => connector.connectorCode === selectedConnectorCode,
  );
  const available = selectedConnector?.status === "AVAILABLE";

  function selectConnector(connectorCode: string): void {
    const connector = station?.connectors.find(
      (candidate) => candidate.connectorCode === connectorCode,
    );
    if (!connector || connector.status !== "AVAILABLE" || checkout) return;
    setSelectedConnectorCode(connector.connectorCode);
    setDurationMinutes(connector.allowedDurationsMinutes.at(0) ?? 60);
  }

  async function createOrder(): Promise<void> {
    if (!selectedConnector) return;
    setCreating(true);
    setError(null);
    try {
      const result = await chargeApi.createOrder({
        connectorCode: selectedConnector.connectorCode,
        durationMinutes,
      });
      if (result.realtimeAccessToken) {
        window.sessionStorage.setItem(
          `charge-token:${result.orderId}`,
          result.realtimeAccessToken,
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
    if (checkout) {
      router.push(`/charge/${encodeURIComponent(checkout.orderId)}`);
    }
  }

  return (
    <main className="scan-shell">
      <Link className="back-link" href="/">
        <ArrowLeft size={16} /> Charger access
      </Link>
      <section className="station-strip" aria-label="Charging station">
        <div className="station-symbol" aria-hidden="true">
          <PlugZap size={24} />
        </div>
        <div>
          <p className="eyebrow">Station QR</p>
          <h1>{station?.stationName ?? "Reading station"}</h1>
        </div>
        <span
          className={`availability ${available ? "is-available" : "is-unavailable"}`}
        >
          {available ? (
            <CircleCheck size={15} />
          ) : (
            <AlertTriangle size={15} />
          )}
          {selectedConnector?.status ?? "CHECKING"}
        </span>
      </section>

      {error ? (
        <p className="page-error" role="alert">
          {error}
        </p>
      ) : null}
      {!station && !error ? (
        <p className="loading-line">Reading station availability...</p>
      ) : null}
      {station ? (
        <div className="scan-workspace">
          <section className="duration-picker" aria-labelledby="connector-heading">
            <div className="section-heading">
              <div className="section-icon" aria-hidden="true">
                <PlugZap size={17} />
              </div>
              <div>
                <p className="eyebrow">Available at this station</p>
                <h2 id="connector-heading">Choose connector</h2>
              </div>
            </div>
            <div className="station-connector-options">
              {station.connectors.map((connector) => {
                const connectorAvailable = connector.status === "AVAILABLE";
                return (
                  <button
                    aria-pressed={
                      connector.connectorCode === selectedConnectorCode
                    }
                    className="station-connector-option"
                    disabled={!connectorAvailable || Boolean(checkout)}
                    key={connector.connectorCode}
                    onClick={() => selectConnector(connector.connectorCode)}
                    type="button"
                  >
                    <strong>{connector.connectorCode}</strong>
                    <span>{connector.status}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {selectedConnector ? (
            <DurationPicker
              disabled={!available || Boolean(checkout)}
              durations={selectedConnector.allowedDurationsMinutes}
              hourlyPriceVnd={selectedConnector.hourlyPriceVnd}
              onSelect={setDurationMinutes}
            />
          ) : null}

          {!checkout && selectedConnector ? (
            <section className="order-action">
              <p>
                Price and availability are confirmed by the station service.
              </p>
              <button
                className="primary-button"
                disabled={!available || creating}
                onClick={createOrder}
                type="button"
              >
                {creating ? "Creating payment link" : "Create payment link"}
              </button>
            </section>
          ) : null}
          {checkout?.payment.checkoutUrl ? (
            <PayosCheckout
              amount={checkout.amount}
              checkoutUrl={checkout.payment.checkoutUrl}
              currency={checkout.currency}
              onViewStatus={viewStatus}
            />
          ) : null}
          {checkout && !checkout.payment.checkoutUrl ? (
            <PaymentPending
              amount={checkout.amount}
              currency={checkout.currency}
              disabled={!checkout.realtimeAccessToken}
              onRefresh={recoverPaymentLink}
              onViewStatus={viewStatus}
              refreshing={recoveringPaymentLink}
            />
          ) : null}
        </div>
      ) : null}
    </main>
  );
}
