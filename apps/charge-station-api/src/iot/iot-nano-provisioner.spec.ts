import { describe, expect, it, vi } from "vitest";

import { provisionIotNanoTenant, resolveIotNanoSeedOutputPath } from "./iot-nano-provisioner.js";

describe("provisionIotNanoTenant", () => {
  it("places the generated Compose secret file at the repository root by default", () => {
    expect(resolveIotNanoSeedOutputPath("/workspace/charge-station")).toBe(
      "/workspace/charge-station/.charge-station-iot-nano.env",
    );
  });

  it("provisions tenant-cs resources through current v1 management APIs", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      if (url.pathname === "/api/v1/system/auth/login") {
        return json(200, {}, { "set-cookie": "system-session=system; Path=/; HttpOnly" });
      }
      if (url.pathname === "/api/v1/system/tenants") {
        expect(body).toMatchObject({
          slug: "tenant-cs",
          tenant_account_username: "tenant-cs",
        });
        return json(201, { id: "tenant-cs-id" });
      }
      if (url.pathname === "/api/v1/tenant/auth/login") {
        return json(200, {}, { "set-cookie": "tenant-session=tenant; Path=/; HttpOnly" });
      }
      if (url.pathname === "/api/v1/management/users" && init?.method === "GET") {
        return json(200, []);
      }
      if (url.pathname === "/api/v1/management/users" && init?.method === "POST") {
        return json(201, { id: body.username + "-id", username: body.username });
      }
      if (url.pathname === "/api/v1/management/devices" && init?.method === "GET") {
        return json(200, []);
      }
      if (url.pathname === "/api/v1/management/devices" && init?.method === "POST") {
        expect(body).toMatchObject({ display_name: "Charge Station Demo Device", serial_number: "CS-DEMO-001" });
        return json(201, { device_id: "charge-device-id" });
      }
      if (url.pathname === "/api/v1/management/devices/charge-device-id/owner") {
        expect(init?.method).toBe("PUT");
        expect(body).toEqual({ user_id: "cs-admin-id" });
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/api/v1/management/devices/charge-device-id/tokens") {
        expect(init?.method).toBe("POST");
        return json(201, { token: "device-token" });
      }
      if (url.pathname === "/api/v1/management/personal-access-token") {
        expect(init?.method).toBe("POST");
        expect(body).toEqual({ name: "charge-station-api" });
        return json(201, { secret: "tenant-pat" });
      }
      throw new Error(`Unexpected request: ${url.pathname} ${init?.method}`);
    });

    await expect(provisionIotNanoTenant({
      apiUrl: "http://127.0.0.1:18081",
      deviceName: "Charge Station Demo Device",
      deviceSerialNumber: "CS-DEMO-001",
      operatorPassword: "operator-password",
      operatorUsername: "cs-operator",
      systemPassword: "system-password",
      systemUsername: "system-admin",
      tenantPassword: "tenant-password",
      tenantSlug: "tenant-cs",
      tenantUsername: "tenant-cs",
      userPassword: "admin-password",
      userUsername: "cs-admin",
    }, fetcher)).resolves.toEqual({
      deviceId: "charge-device-id",
      deviceToken: "device-token",
      pat: "tenant-pat",
    });
  });
});

function json(status: number, payload: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
