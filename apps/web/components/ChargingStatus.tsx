"use client";

import {
  AlertTriangle,
  Check,
  CircleDollarSign,
  LoaderCircle,
  PauseCircle,
  PlugZap,
  Radio,
  Square,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  chargeApi,
  type ChargeApi,
  type OrderStatus,
  type SessionStatus,
} from "../lib/api";
import { createChargeSocket, type ChargeSocket } from "../lib/socket";

interface ChargingStatusProps {
  orderId: string;
  accessToken?: string;
  api?: Pick<ChargeApi, "getOrder" | "getSession" | "stopSession">;
  socket?: ChargeSocket;
}

type RailPhase =
  "waiting" | "paid" | "starting" | "charging" | "completed" | "error";

const phaseDetails: Record<RailPhase, { label: string; message: string }> = {
  waiting: {
    label: "Waiting for payment",
    message:
      "The station is holding this connector until PayOS confirms payment.",
  },
  paid: {
    label: "Payment received",
    message: "The station is preparing a device-owned charging session.",
  },
  starting: {
    label: "Starting charger",
    message: "The charger is confirming its relay state.",
  },
  charging: {
    label: "Charging",
    message: "Live energy time is reported by the charger.",
  },
  completed: {
    label: "Charge complete",
    message: "The charger reported that the session has ended.",
  },
  error: {
    label: "Attention required",
    message: "The station could not continue this charging session.",
  },
};

function phaseFor(
  order: OrderStatus | null,
  session: SessionStatus | null,
): RailPhase {
  if (
    order?.status === "PAYMENT_FAILED" ||
    order?.status === "EXPIRED" ||
    order?.status === "REFUNDED"
  ) {
    return "error";
  }
  if (!session) {
    return order?.status === "PAID" ? "paid" : "waiting";
  }
  if (session.status === "CHARGING") return "charging";
  if (session.status === "COMPLETED") return "completed";
  if (
    session.status === "START_FAILED" ||
    session.status === "CANCELLED" ||
    session.status === "DEVICE_OFFLINE"
  ) {
    return "error";
  }
  return "starting";
}

function formatRemaining(seconds: number | null): string {
  if (seconds === null) return "Awaiting device";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${hours > 0 ? `${hours}h ` : ""}${minutes}m ${remainder}s`;
}

function isSessionStatus(value: unknown): value is SessionStatus["status"] {
  return (
    typeof value === "string" &&
    [
      "PENDING",
      "STARTING",
      "CHARGING",
      "STOPPING",
      "COMPLETED",
      "CANCELLED",
      "START_FAILED",
      "DEVICE_OFFLINE",
    ].includes(value)
  );
}

function readSessionId(payload: unknown): string | null {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "sessionId" in payload &&
    typeof payload.sessionId === "string"
  ) {
    return payload.sessionId;
  }
  return null;
}

export function ChargingStatus({
  orderId,
  accessToken,
  api = chargeApi,
  socket: suppliedSocket,
}: ChargingStatusProps) {
  const [order, setOrder] = useState<OrderStatus | null>(null);
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connected, setConnected] = useState(
    Boolean(suppliedSocket?.connected),
  );
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const socket = useMemo(
    () => suppliedSocket ?? createChargeSocket(),
    [suppliedSocket],
  );
  const phase = phaseFor(order, session);

  async function refreshOrder(): Promise<void> {
    try {
      const nextOrder = await api.getOrder(orderId);
      setOrder(nextOrder);
      if (nextOrder.sessionId) {
        setSessionId(nextOrder.sessionId);
      }
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to read station status",
      );
    }
  }

  async function refreshSession(id: string): Promise<void> {
    try {
      setSession(await api.getSession(id));
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to read charging session",
      );
    }
  }

  useEffect(() => {
    void refreshOrder();
  }, [orderId]);

  useEffect(() => {
    if (sessionId) void refreshSession(sessionId);
  }, [sessionId]);

  useEffect(() => {
    const subscribeOrder = () => {
      setConnected(true);
      if (accessToken) socket.emit("subscribe", { orderId, accessToken });
      void refreshOrder();
    };
    const disconnect = () => setConnected(false);
    const paymentUpdated = (payload?: unknown) => {
      const nextSessionId = readSessionId(payload);
      if (nextSessionId) setSessionId(nextSessionId);
      void refreshOrder();
    };
    const sessionUpdated = (payload?: unknown) => {
      if (isSessionStatus(payload)) {
        setSession((current) =>
          current ? { ...current, status: payload } : current,
        );
      }
    };

    socket.on("connect", subscribeOrder);
    socket.on("disconnect", disconnect);
    socket.on("payment.updated", paymentUpdated);
    socket.on("session.updated", sessionUpdated);
    socket.on("device.updated", sessionUpdated);
    if (socket.connected) subscribeOrder();

    return () => {
      socket.off("connect", subscribeOrder);
      socket.off("disconnect", disconnect);
      socket.off("payment.updated", paymentUpdated);
      socket.off("session.updated", sessionUpdated);
      socket.off("device.updated", sessionUpdated);
      if (!suppliedSocket) socket.disconnect?.();
    };
  }, [accessToken, orderId, socket, suppliedSocket]);

  useEffect(() => {
    if (connected) return;
    const timer = window.setInterval(() => {
      void refreshOrder();
      if (sessionId) void refreshSession(sessionId);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [connected, sessionId]);

  useEffect(() => {
    if (sessionId && connected && accessToken) {
      socket.emit("subscribe", { sessionId, accessToken });
    }
  }, [accessToken, connected, sessionId, socket]);

  async function stopCharging(): Promise<void> {
    if (!sessionId || !accessToken) return;
    setStopping(true);
    try {
      await api.stopSession(sessionId, accessToken);
      await refreshSession(sessionId);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to request charge stop",
      );
    } finally {
      setStopping(false);
    }
  }

  const canStop = Boolean(
    sessionId &&
    accessToken &&
    session &&
    ["STARTING", "CHARGING", "STOPPING"].includes(session.status),
  );

  return (
    <main className="charge-shell">
      <section className="charge-header" aria-label="Charging session">
        <div>
          <p className="eyebrow">Live station status</p>
          <h1>{order?.connectorCode ?? "Connector session"}</h1>
          <p className="order-id">Order {orderId}</p>
        </div>
        <span
          className={`connection-chip ${connected ? "is-online" : "is-polling"}`}
        >
          <Radio size={15} />
          {connected ? "Live" : "Polling"}
        </span>
      </section>

      <section className="status-instrument" aria-live="polite">
        <div
          className={`energy-rail phase-${phase}`}
          aria-label={`Energy rail: ${phaseDetails[phase].label}`}
        >
          {(
            ["waiting", "paid", "starting", "charging", "completed"] as const
          ).map((step) => (
            <span
              className={`rail-marker ${step === phase ? "is-current" : ""}`}
              key={step}
            >
              <i />
              <b>{step}</b>
            </span>
          ))}
        </div>
        <div className="status-readout">
          <div className="phase-icon" aria-hidden="true">
            {phase === "waiting" && <CircleDollarSign size={28} />}
            {phase === "paid" && <Check size={28} />}
            {phase === "starting" && <LoaderCircle size={28} />}
            {phase === "charging" && <PlugZap size={28} />}
            {phase === "completed" && <PauseCircle size={28} />}
            {phase === "error" && <AlertTriangle size={28} />}
          </div>
          <p className="eyebrow">
            {session?.timerAuthority === "DEVICE"
              ? "Device-owned timer"
              : "Station order"}
          </p>
          <h2>{phaseDetails[phase].label}</h2>
          <p>{phaseDetails[phase].message}</p>
          {session && (
            <dl className="session-metrics">
              <div>
                <dt>Remaining</dt>
                <dd>{formatRemaining(session.estimatedRemainingSeconds)}</dd>
              </div>
              <div>
                <dt>Device status</dt>
                <dd>{session.status}</dd>
              </div>
            </dl>
          )}
          {session?.operationalWarning && (
            <p className="status-warning">{session.operationalWarning}</p>
          )}
          {error && <p className="status-error">{error}</p>}
          {canStop && (
            <button
              className="stop-button"
              type="button"
              disabled={stopping}
              onClick={stopCharging}
            >
              <Square size={15} fill="currentColor" />
              {stopping ? "Requesting stop" : "Stop charging"}
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
