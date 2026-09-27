export type ConnectorStatus = "AVAILABLE" | "OCCUPIED" | "OFFLINE";

export interface StationScan {
  stationName: string;
  connectors: Array<{
    connectorCode: string;
    status: ConnectorStatus;
    allowedDurationsMinutes: number[];
    hourlyPriceVnd: number;
  }>;
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

export interface AdminOverview {
  stations: number;
  connectors: {
    total: number;
    available: number;
    occupied: number;
    offline: number;
  };
  sessions: {
    active: number;
    charging: number;
    attention: number;
  };
  revenueTodayVnd: number;
  paymentsPending: number;
  alerts: AdminAlert[];
}

export interface AdminAlert {
  category: "CONNECTOR_OFFLINE" | "START_FAILED" | "DEVICE_OFFLINE";
  message: string;
  stationCode: string;
  connectorCode: string;
  sessionId?: string;
}

export interface AdminSession {
  id: string;
  orderId: string;
  status: SessionStatus["status"];
  stationCode: string;
  stationName: string;
  connectorCode: string;
  amountVnd: number;
  durationMinutes: number;
  requestedAt: string;
  checkInAt: string | null;
  expectedEndAt: string | null;
  checkOutAt: string | null;
  actualDurationSeconds: number | null;
  estimatedRemainingSeconds: number | null;
  lastDeviceEventAt: string | null;
  operationalWarning: string | null;
}

export interface AdminStation {
  id: string;
  code: string;
  name: string;
  deviceId: string | null;
  status: "AVAILABLE" | "IN_USE" | "UNAVAILABLE";
  telemetry:
    | {
        status: "AVAILABLE";
        eventAt: string;
        relayState: boolean | null;
        sessionId: string | null;
        remainingSeconds: number | null;
        lastStopReason: string | null;
        voltageV: number | null;
        currentA: number | null;
        powerW: number | null;
        energyKwh: number | null;
      }
    | { status: "UNAVAILABLE" };
  connectors: Array<{
    id: string;
    code: string;
    status: ConnectorStatus;
    hourlyPriceVnd: number | null;
    activeSession: AdminSession | null;
  }>;
}

export interface AdminPayment {
  id: string;
  provider: string;
  status: string;
  cancellationStatus: string;
  amountVnd: number;
  currency: string;
  orderId: string;
  payosOrderCode: string;
  connectorCode: string;
  checkoutUrl: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdminDeviceTimelineItem {
  id: string;
  kind: "COMMAND" | "EVENT";
  type: string;
  status: string;
  at: string;
  connectorCode: string;
  sessionId: string | null;
  retryCount: number | null;
  details: Record<string, unknown>;
}

export interface AdminDeviceRelay {
  enabled: boolean | null;
  remainingSeconds: number | null;
  voltageV: number | null;
  currentA: number | null;
  powerW: number | null;
  energyKwh: number | null;
  source: string | null;
}

export interface AdminDevice {
  deviceId: string;
  stationId: string | null;
  stationCode: string | null;
  stationName: string | null;
  status: "AVAILABLE" | "IN_USE" | "OFFLINE";
  activeSessionId: string | null;
  relayIds: string[];
  telemetry: {
    eventAt: string;
    totalPowerW: number | null;
    totalEnergyKwh: number | null;
    relays: Record<string, AdminDeviceRelay> | null;
  } | null;
}

export interface AdminStationQr {
  stationId: string;
  qrVersion: number;
  scanUrl: string;
}

export interface ChargeApi {
  getStationScan(token: string): Promise<StationScan>;
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

export interface AdminApi {
  login(input: {
    email: string;
    password: string;
  }): Promise<{ accessToken: string }>;
  getOverview(accessToken: string): Promise<AdminOverview>;
  getStations(accessToken: string): Promise<AdminStation[]>;
  createStation(
    input: {
      code: string;
      deviceId?: string;
    },
    accessToken: string,
  ): Promise<AdminStation>;
  linkStationDevice(
    stationId: string,
    deviceId: string,
    accessToken: string,
  ): Promise<AdminStation>;
  getStationQr(
    stationId: string,
    accessToken: string,
  ): Promise<AdminStationQr>;
  rotateStationQr(
    stationId: string,
    accessToken: string,
  ): Promise<AdminStationQr>;
  getSessions(accessToken: string): Promise<AdminSession[]>;
  getPayments(accessToken: string): Promise<AdminPayment[]>;
  getDeviceTimeline(
    accessToken: string,
  ): Promise<AdminDeviceTimelineItem[]>;
  getDevices(accessToken: string): Promise<AdminDevice[]>;
  getDevice(deviceId: string, accessToken: string): Promise<AdminDevice>;
  controlDeviceRelay(
    deviceId: string,
    relayId: string,
    input: { enabled: boolean; durationSeconds?: number },
    accessToken: string,
  ): Promise<{ relayId: string; enabled: boolean }>;
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
    getStationScan: (token) =>
      request<StationScan>(
        local,
        `/public/stations/scan/${encodeURIComponent(token)}`,
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

function adminHeaders(accessToken: string): HeadersInit {
  return { authorization: `Bearer ${accessToken}` };
}

export function createAdminApi(origin = localApiOrigin): AdminApi {
  const local = localOrigin(origin, localApiOrigin);
  return {
    login: (input) =>
      request<{ accessToken: string }>(local, "/auth/login", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    getOverview: (accessToken) =>
      request<AdminOverview>(local, "/admin/overview", {
        headers: adminHeaders(accessToken),
      }),
    getStations: (accessToken) =>
      request<AdminStation[]>(local, "/admin/stations", {
        headers: adminHeaders(accessToken),
      }),
    createStation: (input, accessToken) =>
      request<AdminStation>(local, "/admin/stations", {
        method: "POST",
        headers: adminHeaders(accessToken),
        body: JSON.stringify(input),
      }),
    linkStationDevice: (stationId, deviceId, accessToken) =>
      request<AdminStation>(
        local,
        `/admin/stations/${encodeURIComponent(stationId)}/device`,
        {
          method: "PUT",
          headers: adminHeaders(accessToken),
          body: JSON.stringify({ deviceId }),
        },
      ),
    getStationQr: (stationId, accessToken) =>
      request<AdminStationQr>(
        local,
        `/admin/stations/${encodeURIComponent(stationId)}/qr`,
        { headers: adminHeaders(accessToken) },
      ),
    rotateStationQr: (stationId, accessToken) =>
      request<AdminStationQr>(
        local,
        `/admin/stations/${encodeURIComponent(stationId)}/qr/rotate`,
        {
          method: "POST",
          headers: adminHeaders(accessToken),
        },
      ),
    getSessions: (accessToken) =>
      request<AdminSession[]>(local, "/admin/sessions?limit=50", {
        headers: adminHeaders(accessToken),
      }),
    getPayments: (accessToken) =>
      request<AdminPayment[]>(local, "/admin/payments?limit=50", {
        headers: adminHeaders(accessToken),
      }),
    getDeviceTimeline: (accessToken) =>
      request<AdminDeviceTimelineItem[]>(
        local,
        "/admin/device-timeline?limit=100",
        {
          headers: adminHeaders(accessToken),
        },
      ),
    getDevices: (accessToken) =>
      request<AdminDevice[]>(local, "/admin/devices", {
        headers: adminHeaders(accessToken),
      }),
    getDevice: (deviceId, accessToken) =>
      request<AdminDevice>(
        local,
        `/admin/devices/${encodeURIComponent(deviceId)}`,
        { headers: adminHeaders(accessToken) },
      ),
    controlDeviceRelay: (deviceId, relayId, input, accessToken) =>
      request<{ relayId: string; enabled: boolean }>(
        local,
        `/admin/devices/${encodeURIComponent(deviceId)}/relays/${encodeURIComponent(relayId)}`,
        {
          method: "POST",
          headers: adminHeaders(accessToken),
          body: JSON.stringify(input),
        },
      ),
    stopSession: (sessionId, accessToken) =>
      request<{ accepted: true }>(
        local,
        `/admin/sessions/${encodeURIComponent(sessionId)}/stop`,
        {
          method: "POST",
          headers: adminHeaders(accessToken),
        },
      ),
    retryStart: (sessionId, accessToken) =>
      request<{ accepted: true }>(
        local,
        `/admin/sessions/${encodeURIComponent(sessionId)}/retry-start`,
        {
          method: "POST",
          headers: adminHeaders(accessToken),
        },
      ),
  };
}

export const adminApi = createAdminApi();
