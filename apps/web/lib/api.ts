export interface Connector {
  stationCode: string;
  connectorCode: string;
  status: "AVAILABLE" | "OCCUPIED" | "OFFLINE";
  allowedDurationsMinutes: number[];
  hourlyPriceVnd: number;
}

export interface CheckoutOrder {
  orderId: string;
  amount: number;
  currency: string;
  payment: CheckoutPayment;
  realtimeAccessToken?: string;
}

export interface CheckoutPayment {
  provider: "PAYOS";
  checkoutUrl?: string;
  paymentPending?: true;
}

export interface OrderStatus {
  id: string;
  status:
    "PENDING_PAYMENT" | "PAID" | "PAYMENT_FAILED" | "EXPIRED" | "REFUNDED";
  amountVnd: number;
  currency: string;
  durationMinutes: number;
  connectorCode: string;
  sessionId?: string;
  payment: {
    provider: string;
    status: string;
    checkoutUrl?: string | null;
  } | null;
}

export interface SessionStatus {
  id: string;
  orderId: string;
  status:
    | "PENDING"
    | "STARTING"
    | "CHARGING"
    | "STOPPING"
    | "COMPLETED"
    | "CANCELLED"
    | "START_FAILED"
    | "DEVICE_OFFLINE";
  estimatedRemainingSeconds: number | null;
  timerAuthority: "DEVICE";
  lastDeviceEventAt: string | null;
  operationalWarning: string | null;
}

export interface ChargeApi {
  getConnector(connectorCode: string): Promise<Connector>;
  createOrder(input: {
    connectorCode: string;
    durationMinutes: number;
  }): Promise<CheckoutOrder>;
  getPaymentLink(
    orderId: string,
    accessToken: string,
  ): Promise<CheckoutPayment>;
  getOrder(orderId: string, accessToken: string): Promise<OrderStatus>;
  getSession(sessionId: string, accessToken: string): Promise<SessionStatus>;
  stopSession(
    sessionId: string,
    accessToken: string,
  ): Promise<{ accepted: true }>;
  retryStart(
    sessionId: string,
    accessToken: string,
  ): Promise<{ accepted: true }>;
}

function localUrl(value: string | undefined, fallback: string): URL {
  const url = new URL(value?.trim() || fallback);
  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (url.protocol !== "http:" || !localHosts.has(url.hostname)) {
    throw new Error("The charging interface only accepts a local HTTP API URL");
  }
  return url;
}

function localOrigin(value: string | undefined, fallback: string): string {
  const url = localUrl(value, fallback);
  return url.origin;
}

function validateCheckoutUrl(value: string, localOrigin: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid checkout URL");
  }

  const isLocalCheckout = url.origin === localOrigin;
  const isPayosCheckout =
    url.protocol === "https:" &&
    url.hostname === "pay.payos.vn" &&
    url.port === "" &&
    !url.username &&
    !url.password;

  if (!isLocalCheckout && !isPayosCheckout) {
    throw new Error("Invalid checkout URL");
  }
  return url.toString();
}

function validateCheckoutPayment(
  payment: CheckoutPayment,
  localOrigin: string,
): CheckoutPayment {
  if (payment.checkoutUrl === undefined) {
    return payment;
  }
  return {
    ...payment,
    checkoutUrl: validateCheckoutUrl(payment.checkoutUrl, localOrigin),
  };
}

export const localApiOrigin = localOrigin(
  process.env.NEXT_PUBLIC_API_URL,
  "http://localhost:4000",
);

async function request<T>(
  origin: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string | string[];
    } | null;
    const message = Array.isArray(body?.message)
      ? body.message.join(", ")
      : body?.message;
    throw new Error(message || `Local API request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export function createChargeApi(origin = localApiOrigin): ChargeApi {
  const local = localOrigin(origin, localApiOrigin);
  return {
    getConnector: (connectorCode) =>
      request<Connector>(
        local,
        `/public/connectors/${encodeURIComponent(connectorCode)}`,
      ),
    createOrder: async (input) => {
      const order = await request<CheckoutOrder>(local, "/orders", {
        method: "POST",
        body: JSON.stringify(input),
      });
      return {
        ...order,
        payment: validateCheckoutPayment(order.payment, local),
      };
    },
    getPaymentLink: async (orderId, accessToken) =>
      validateCheckoutPayment(
        await request<CheckoutPayment>(
          local,
          `/orders/${encodeURIComponent(orderId)}/payment-link`,
          { headers: { authorization: `Bearer ${accessToken}` } },
        ),
        local,
      ),
    getOrder: (orderId, accessToken) =>
      request<OrderStatus>(local, `/orders/${encodeURIComponent(orderId)}`, {
        headers: { authorization: `Bearer ${accessToken}` },
      }),
    getSession: (sessionId, accessToken) =>
      request<SessionStatus>(
        local,
        `/sessions/${encodeURIComponent(sessionId)}`,
        { headers: { authorization: `Bearer ${accessToken}` } },
      ),
    stopSession: (sessionId, accessToken) =>
      request<{ accepted: true }>(
        local,
        `/sessions/${encodeURIComponent(sessionId)}/stop`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}` },
        },
      ),
    retryStart: (sessionId, accessToken) =>
      request<{ accepted: true }>(
        local,
        `/sessions/${encodeURIComponent(sessionId)}/retry-start`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}` },
        },
      ),
  };
}

export const chargeApi = createChargeApi();
