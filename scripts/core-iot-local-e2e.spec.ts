import { readFile } from "node:fs/promises";
import { stat } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  isolatedCoreUrls,
  writeDeviceTokenEnvironment,
} from "./core-iot-local-e2e.js";

describe("Core IoT local runtime", () => {
  it("runs no iot-service mock and passes Core configuration to API", async () => {
    const compose = await readFile("docker-compose.yml", "utf8");

    expect(compose).not.toContain("iot-service:");
    expect(compose).not.toContain("MOCK_IOT_");
    expect(compose).toContain("IOT_CORE_PUBLIC_URL");
    expect(compose).toContain("core-iot-device-simulator:");
  });

  it("rejects provisioning endpoints other than the isolated local Core", () => {
    expect(() =>
      isolatedCoreUrls({ CORE_IOT_PUBLIC_URL: "http://localhost:18090" }),
    ).toThrow("CORE_IOT_PUBLIC_URL must be the isolated local Core endpoint");
    expect(() =>
      isolatedCoreUrls({ CORE_IOT_MANAGEMENT_URL: "http://127.0.0.1:18092" }),
    ).toThrow(
      "CORE_IOT_MANAGEMENT_URL must be the isolated local Core endpoint",
    );
  });

  it("keeps a provisioned device token in a private temporary directory", async () => {
    const runtimeSecret =
      await writeDeviceTokenEnvironment("test-device-token");
    try {
      expect((await stat(runtimeSecret.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(runtimeSecret.envFile)).mode & 0o777).toBe(0o600);
      expect(await readFile(runtimeSecret.envFile, "utf8")).toBe(
        "IOT_CORE_DEVICE_TOKEN=test-device-token\n",
      );
    } finally {
      await runtimeSecret.dispose();
    }
  });
});
