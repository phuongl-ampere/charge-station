export interface IotNanoTenantProvisioningConfig {
  apiUrl: string;
  deviceName: string;
  deviceSerialNumber: string;
  operatorPassword: string;
  operatorUsername: string;
  systemPassword: string;
  systemUsername: string;
  tenantPassword: string;
  tenantSlug: string;
  tenantUsername: string;
  userPassword: string;
  userUsername: string;
}

export interface IotNanoTenantProvisioningResult {
  deviceId: string;
  deviceToken: string;
  pat: string;
}

export function resolveIotNanoSeedOutputPath(
  repositoryRoot: string,
  configuredPath?: string,
): string {
  return resolve(repositoryRoot, configuredPath?.trim() || ".charge-station-iot-nano.env");
}

export async function provisionIotNanoTenant(
  config: IotNanoTenantProvisioningConfig,
  fetcher: typeof fetch = fetch,
): Promise<IotNanoTenantProvisioningResult> {
  const apiUrl = apiBaseUrl(config.apiUrl);
  const systemLogin = await request(fetcher, apiUrl, "/api/v1/system/auth/login", {
    method: "POST",
    body: { username: config.systemUsername, password: config.systemPassword },
  });
  const systemCookie = sessionCookie(systemLogin, "system login");
  const createTenant = await request(fetcher, apiUrl, "/api/v1/system/tenants", {
    method: "POST",
    cookie: systemCookie,
    body: {
      slug: config.tenantSlug,
      metadata: { application: "charge-station" },
      tenant_account_username: config.tenantUsername,
      tenant_account_password: config.tenantPassword,
    },
    allowedStatus: [201, 409],
  });
  if (createTenant.status !== 201 && createTenant.status !== 409) {
    throw new Error(`tenant provisioning failed with HTTP ${createTenant.status}`);
  }
  const tenantLogin = await request(fetcher, apiUrl, "/api/v1/tenant/auth/login", {
    method: "POST",
    body: { tenant_slug: config.tenantSlug, password: config.tenantPassword },
  });
  const tenantCookie = sessionCookie(tenantLogin, "tenant login");
  const admin = await ensureUser(fetcher, apiUrl, tenantCookie, {
    username: config.userUsername,
    password: config.userPassword,
  });
  await ensureUser(fetcher, apiUrl, tenantCookie, {
    username: config.operatorUsername,
    password: config.operatorPassword,
  });
  const deviceId = await ensureDevice(fetcher, apiUrl, tenantCookie, {
    name: config.deviceName,
    serialNumber: config.deviceSerialNumber,
  });
  await request(fetcher, apiUrl, `/api/v1/management/devices/${encodeURIComponent(deviceId)}/owner`, {
    method: "PUT",
    cookie: tenantCookie,
    body: { user_id: admin.id },
    allowedStatus: [204],
  });
  const deviceToken = await responseJson<{ token?: unknown }>(
    await request(fetcher, apiUrl, `/api/v1/management/devices/${encodeURIComponent(deviceId)}/tokens`, {
      method: "POST",
      cookie: tenantCookie,
      allowedStatus: [201],
    }),
    "device token",
  );
  const pat = await responseJson<{ secret?: unknown }>(
    await request(fetcher, apiUrl, "/api/v1/management/personal-access-token", {
      method: "POST",
      cookie: tenantCookie,
      body: { name: "charge-station-api" },
      allowedStatus: [201],
    }),
    "tenant personal access token",
  );
  return {
    deviceId,
    deviceToken: requiredString(deviceToken.token, "device token"),
    pat: requiredString(pat.secret, "tenant personal access token"),
  };
}

async function ensureUser(
  fetcher: typeof fetch,
  apiUrl: URL,
  cookie: string,
  input: { username: string; password: string },
): Promise<{ id: string }> {
  const users = await responseJson<unknown>(
    await request(fetcher, apiUrl, "/api/v1/management/users", {
      method: "GET",
      cookie,
    }),
    "tenant users",
  );
  if (Array.isArray(users)) {
    const existing = users.find(
      (user): user is Record<string, unknown> => isRecord(user) && user.username === input.username,
    );
    if (existing !== undefined) return { id: requiredString(existing.id, "tenant user id") };
  }
  const created = await responseJson<Record<string, unknown>>(
    await request(fetcher, apiUrl, "/api/v1/management/users", {
      method: "POST",
      cookie,
      body: input,
      allowedStatus: [201],
    }),
    "tenant user",
  );
  return { id: requiredString(created.id, "tenant user id") };
}

async function ensureDevice(
  fetcher: typeof fetch,
  apiUrl: URL,
  cookie: string,
  input: { name: string; serialNumber: string },
): Promise<string> {
  const devices = await responseJson<unknown>(
    await request(fetcher, apiUrl, "/api/v1/management/devices", {
      method: "GET",
      cookie,
    }),
    "tenant devices",
  );
  if (Array.isArray(devices)) {
    const existing = devices.find(
      (device): device is Record<string, unknown> => isRecord(device) && device.serial_number === input.serialNumber,
    );
    if (existing !== undefined) return requiredString(existing.device_id, "device id");
  }
  const created = await responseJson<Record<string, unknown>>(
    await request(fetcher, apiUrl, "/api/v1/management/devices", {
      method: "POST",
      cookie,
      body: {
        serial_number: input.serialNumber,
        display_name: input.name,
        attributes: { application: "charge-station" },
      },
      allowedStatus: [201],
    }),
    "charge station device",
  );
  return requiredString(created.device_id, "device id");
}

async function request(
  fetcher: typeof fetch,
  apiUrl: URL,
  path: string,
  input: {
    allowedStatus?: number[];
    body?: unknown;
    cookie?: string;
    method: "GET" | "POST" | "PUT";
  },
): Promise<Response> {
  const headers = new Headers({ accept: "application/json" });
  if (input.cookie !== undefined) headers.set("cookie", input.cookie);
  if (input.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetcher(new URL(path, apiUrl), {
    method: input.method,
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    redirect: "error",
  });
  const allowedStatus = input.allowedStatus ?? [200];
  if (!allowedStatus.includes(response.status)) {
    throw new Error(`${input.method} ${path} failed with HTTP ${response.status}`);
  }
  return response;
}

async function responseJson<T>(response: Response, label: string): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    throw new Error(`${label} response was not JSON`);
  }
}

function apiBaseUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error("IoT Nano API URL must be an absolute HTTP URL");
  }
  return url;
}

function sessionCookie(response: Response, label: string): string {
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null || setCookie.length === 0) {
    throw new Error(`${label} did not return a session cookie`);
  }
  const cookie = setCookie.split(";", 1)[0];
  if (cookie === undefined || cookie.length === 0) {
    throw new Error(`${label} returned an invalid session cookie`);
  }
  return cookie;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is missing`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
import { resolve } from "node:path";
