import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ISOLATED_CORE_PUBLIC_URL = "http://127.0.0.1:18090";
const ISOLATED_CORE_MANAGEMENT_URL = "http://127.0.0.1:18091";
const DEFAULT_API_URL = "http://127.0.0.1:4000";
const DEFAULT_TENANT_SLUG = "tenant1";
const DEFAULT_USER_NAME = "user-a";
const DEFAULT_DEVICE_NAME = "Charge Station Simulator";
const WAIT_TIMEOUT_MS = 45_000;
const WAIT_INTERVAL_MS = 500;

export interface IsolatedCoreUrls {
  publicUrl: URL;
  managementUrl: URL;
}

interface ManagementSession {
  cookie: string;
}

interface Tenant {
  slug: string;
  session: ManagementSession;
}

interface User {
  id: string;
  username: string;
}

interface Device {
  id: string;
  token: string;
}

interface RuntimeSecretFile {
  directory: string;
  envFile: string;
  dispose(): Promise<void>;
}

interface CoreTelemetry {
  relayState: boolean | null;
}

export function isolatedCoreUrls(
  environment: NodeJS.ProcessEnv = process.env,
): IsolatedCoreUrls {
  return {
    publicUrl: exactIsolatedUrl(
      environment.CORE_IOT_PUBLIC_URL ?? ISOLATED_CORE_PUBLIC_URL,
      ISOLATED_CORE_PUBLIC_URL,
      "CORE_IOT_PUBLIC_URL",
    ),
    managementUrl: exactIsolatedUrl(
      environment.CORE_IOT_MANAGEMENT_URL ?? ISOLATED_CORE_MANAGEMENT_URL,
      ISOLATED_CORE_MANAGEMENT_URL,
      "CORE_IOT_MANAGEMENT_URL",
    ),
  };
}

export async function writeDeviceTokenEnvironment(
  deviceToken: string,
): Promise<RuntimeSecretFile> {
  if (!deviceToken || /[\r\n]/.test(deviceToken)) {
    throw new Error("Core device token is invalid");
  }
  const directory = await mkdtemp(join(tmpdir(), "charge-station-core-iot-"));
  await chmod(directory, 0o700);
  const envFile = join(directory, "compose.env");
  await writeFile(envFile, `IOT_CORE_DEVICE_TOKEN=${deviceToken}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(envFile, 0o600);
  return {
    directory,
    envFile,
    dispose: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function ensureTenant(input: {
  slug: string;
  password: string;
}): Promise<Tenant> {
  const urls = isolatedCoreUrls();
  const response = await managementJson(
    urls.managementUrl,
    "/api/tenant/auth/login",
    {
      method: "POST",
      body: { tenant_slug: input.slug, password: input.password },
    },
  );
  return { slug: input.slug, session: { cookie: requiredCookie(response) } };
}

export async function ensureUser(
  tenant: Tenant,
  input: { username: string; password: string },
): Promise<User> {
  const urls = isolatedCoreUrls();
  const users = await managementJsonBody(
    urls.managementUrl,
    "/api/management/users",
    { headers: managementHeaders(tenant.session) },
  );
  const existing = arrayOfRecords(users).find(
    (user) => user.username === input.username && user.account_class === "user",
  );
  if (existing) {
    return {
      id: requiredString(existing, "id", "Core management user"),
      username: input.username,
    };
  }

  const created = await managementJsonBody(
    urls.managementUrl,
    "/api/management/users",
    {
      method: "POST",
      headers: managementHeaders(tenant.session),
      body: input,
    },
  );
  return {
    id: requiredString(
      asRecord(created, "Core management user"),
      "id",
      "Core management user",
    ),
    username: input.username,
  };
}

export async function ensureDevice(
  tenant: Tenant,
  user: User,
  input: { name: string },
): Promise<Device> {
  const urls = isolatedCoreUrls();
  const configuredId = requiredEnvironment("IOT_CORE_DEVICE_ID");
  const devices = await managementJsonBody(
    urls.managementUrl,
    "/api/management/devices",
    { headers: managementHeaders(tenant.session) },
  );
  const existing = arrayOfRecords(devices).find(
    (device) => device.device_id === configuredId,
  );
  const device = existing
    ? existing
    : asRecord(
        await managementJsonBody(
          urls.managementUrl,
          "/api/management/devices",
          {
            method: "POST",
            headers: managementHeaders(tenant.session),
            body: { display_name: input.name, attributes: {} },
          },
        ),
        "Core device",
      );
  const id = requiredString(device, "device_id", "Core device");
  if (id !== configuredId) {
    throw new Error(
      "IOT_CORE_DEVICE_ID does not identify the provisioned Core device",
    );
  }

  await managementJsonBody(
    urls.managementUrl,
    `/api/management/devices/${encodeURIComponent(id)}/owner`,
    {
      method: "PUT",
      headers: managementHeaders(tenant.session),
      body: { user_id: user.id },
      allowStatus: [204],
    },
  );
  const tokenResponse = asRecord(
    await managementJsonBody(
      urls.managementUrl,
      `/api/management/devices/${encodeURIComponent(id)}/token`,
      { headers: managementHeaders(tenant.session) },
    ),
    "Core device token response",
  );
  return {
    id,
    token: requiredString(tokenResponse, "token", "Core device token response"),
  };
}

export async function run(): Promise<void> {
  const urls = isolatedCoreUrls();
  const tenant = await ensureTenant({
    slug: process.env.CORE_TENANT_SLUG?.trim() || DEFAULT_TENANT_SLUG,
    password: requiredEnvironment("CORE_TENANT_PASSWORD"),
  });
  const user = await ensureUser(tenant, {
    username: process.env.CORE_USER_NAME?.trim() || DEFAULT_USER_NAME,
    password: requiredEnvironment("CORE_USER_PASSWORD"),
  });
  const device = await ensureDevice(tenant, user, {
    name: process.env.CORE_DEVICE_NAME?.trim() || DEFAULT_DEVICE_NAME,
  });
  const runtimeSecrets = await writeDeviceTokenEnvironment(device.token);
  try {
    await runCompose(runtimeSecrets.envFile);
  } finally {
    await runtimeSecrets.dispose();
  }

  const core = new PublicCoreClient(
    urls.publicUrl,
    requiredEnvironment("IOT_CORE_ACCESS_TOKEN"),
  );
  const api = new ChargeStationApi(apiUrl());
  await waitFor(() => core.latestTelemetry(device.id));
  const order = await api.createAndPayLocalOrder("ST01-C01", 60);
  await waitFor(async () => {
    const session = await api.sessionStatus(order.sessionId, order.accessToken);
    return session === "CHARGING";
  });
  assertRelayState(await core.latestTelemetry(device.id), true);
  await api.stopSession(order.sessionId, order.accessToken);
  await waitFor(async () => {
    const session = await api.sessionStatus(order.sessionId, order.accessToken);
    return session === "CANCELLED";
  });
  assertRelayState(await core.latestTelemetry(device.id), false);
  console.log("Core IoT local charging flow verified.");
}

class PublicCoreClient {
  constructor(
    private readonly baseUrl: URL,
    private readonly accessToken: string,
  ) {}

  async latestTelemetry(deviceId: string): Promise<CoreTelemetry | null> {
    const now = new Date();
    const url = new URL(
      `/api/v1/telemetry/${encodeURIComponent(deviceId)}`,
      this.baseUrl,
    );
    url.searchParams.set(
      "from",
      new Date(now.valueOf() - 15 * 60_000).toISOString(),
    );
    url.searchParams.set("to", now.toISOString());
    url.searchParams.set("limit", "100");
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${this.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(
        `Core public telemetry request failed with HTTP ${response.status}`,
      );
    }
    const body = asRecord(await response.json(), "Core telemetry response");
    const items = Array.isArray(body.items) ? body.items : [];
    const latest = items.at(-1);
    if (!latest || !isRecord(latest) || !isRecord(latest.measurements)) {
      return null;
    }
    const relayState = latest.measurements.relay_state;
    return { relayState: typeof relayState === "boolean" ? relayState : null };
  }
}

class ChargeStationApi {
  constructor(private readonly baseUrl: URL) {}

  async createAndPayLocalOrder(
    connectorCode: string,
    durationMinutes: number,
  ): Promise<{ sessionId: string; accessToken: string }> {
    const created = asRecord(
      await this.request("/orders", {
        method: "POST",
        body: { connectorCode, durationMinutes },
      }),
      "local order response",
    );
    const orderId = requiredString(created, "orderId", "local order response");
    const accessToken = requiredString(
      created,
      "realtimeAccessToken",
      "local order response",
    );
    const payment = asRecord(created.payment, "local order payment");
    const checkoutUrl = new URL(
      requiredString(payment, "checkoutUrl", "local order payment"),
    );
    if (checkoutUrl.origin !== this.baseUrl.origin) {
      throw new Error(
        "Local payment checkout URL must target the Charge Station API",
      );
    }
    await this.request(`${checkoutUrl.pathname}/complete`, { method: "POST" });
    const order = asRecord(
      await waitFor(async () => {
        const candidate = asRecord(
          await this.request(`/orders/${encodeURIComponent(orderId)}`, {
            headers: bearerHeaders(accessToken),
          }),
          "local order status",
        );
        return typeof candidate.sessionId === "string" ? candidate : null;
      }),
      "local order status",
    );
    return {
      sessionId: requiredString(order, "sessionId", "local order status"),
      accessToken,
    };
  }

  async sessionStatus(sessionId: string, accessToken: string): Promise<string> {
    const session = asRecord(
      await this.request(`/sessions/${encodeURIComponent(sessionId)}`, {
        headers: bearerHeaders(accessToken),
      }),
      "local session response",
    );
    return requiredString(session, "status", "local session response");
  }

  async stopSession(sessionId: string, accessToken: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/stop`, {
      method: "POST",
      headers: bearerHeaders(accessToken),
      allowStatus: [202],
    });
  }

  private async request(
    path: string,
    options: {
      method?: string;
      headers?: HeadersInit;
      body?: unknown;
      allowStatus?: number[];
    } = {},
  ): Promise<unknown> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: options.method,
      headers: {
        ...(options.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...options.headers,
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(10_000),
    });
    const allowed = options.allowStatus ?? [200, 201];
    if (!allowed.includes(response.status)) {
      throw new Error(
        `Charge Station API request failed with HTTP ${response.status}`,
      );
    }
    if (response.status === 204) {
      return undefined;
    }
    return response.json();
  }
}

async function managementJson(
  baseUrl: URL,
  path: string,
  options: {
    method?: string;
    headers?: HeadersInit;
    body?: unknown;
    allowStatus?: number[];
  } = {},
): Promise<Response> {
  const response = await fetch(new URL(path, baseUrl), {
    method: options.method,
    headers: {
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(10_000),
  });
  const allowed = options.allowStatus ?? [200, 201];
  if (!allowed.includes(response.status)) {
    throw new Error(
      `Core management request failed with HTTP ${response.status}`,
    );
  }
  return response;
}

async function managementJsonBody(
  baseUrl: URL,
  path: string,
  options: {
    method?: string;
    headers?: HeadersInit;
    body?: unknown;
    allowStatus?: number[];
  } = {},
): Promise<unknown> {
  const response = await managementJson(baseUrl, path, options);
  return response.status === 204 ? undefined : response.json();
}

function managementHeaders(session: ManagementSession): HeadersInit {
  return { cookie: session.cookie };
}

function requiredCookie(response: Response): string {
  const cookies = response.headers.getSetCookie?.() ?? [];
  const session = cookies.find((cookie) =>
    cookie.startsWith("iot_nano_session="),
  );
  if (!session) {
    throw new Error("Core management login did not return a session cookie");
  }
  return session.split(";", 1)[0];
}

function exactIsolatedUrl(value: string, expected: string, name: string): URL {
  let candidate: URL;
  try {
    candidate = new URL(value);
  } catch {
    throw new Error(`${name} must be the isolated local Core endpoint`);
  }
  if (candidate.href !== `${expected}/`) {
    throw new Error(`${name} must be the isolated local Core endpoint`);
  }
  return candidate;
}

function apiUrl(): URL {
  const configured = process.env.CHARGE_STATION_API_URL ?? DEFAULT_API_URL;
  try {
    const url = new URL(configured);
    if (url.protocol !== "http:" || url.username || url.password) {
      throw new Error();
    }
    return url;
  } catch {
    throw new Error(
      "CHARGE_STATION_API_URL must be an absolute local HTTP URL",
    );
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be supplied in the environment`);
  }
  return value;
}

async function runCompose(secretEnvFile: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "docker",
      ["compose", "--env-file", secretEnvFile, "up", "-d", "--build", "--wait"],
      { stdio: "inherit" },
    );
    child.once("error", () =>
      reject(new Error("Unable to start Docker Compose")),
    );
    child.once("exit", (code) => {
      code === 0
        ? resolve()
        : reject(new Error("Docker Compose did not start successfully"));
    });
  });
}

async function waitFor<T>(
  operation: () => Promise<T | null | false>,
): Promise<T> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result) {
        return result;
      }
    } catch (error: unknown) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
  }
  if (lastError instanceof Error) {
    throw new Error(
      `Timed out waiting for the Core IoT flow: ${lastError.message}`,
    );
  }
  throw new Error("Timed out waiting for the Core IoT flow");
}

function assertRelayState(
  telemetry: CoreTelemetry | null,
  expected: boolean,
): void {
  if (!telemetry || telemetry.relayState !== expected) {
    throw new Error("Core telemetry did not confirm the expected relay state");
  }
}

function bearerHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

function asRecord(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${description} is invalid`);
  }
  return value;
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  description: string,
): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || !candidate) {
    throw new Error(`${description} is invalid`);
  }
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void run().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Core IoT local E2E failed",
    );
    process.exitCode = 1;
  });
}
