import { chmod, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  provisionIotNanoTenant,
  resolveIotNanoSeedOutputPath,
  type IotNanoTenantProvisioningConfig,
} from "../apps/charge-station-api/src/iot/iot-nano-provisioner.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolveIotNanoSeedOutputPath(
  repositoryRoot,
  process.env.IOT_NANO_SEED_OUTPUT,
);

const result = await provisionIotNanoTenant(seedConfig());
await writeFile(
  outputPath,
  [
    `IOT_NANO_PAT=${result.pat}`,
    `IOT_NANO_DEVICE_ID=${result.deviceId}`,
    `IOT_NANO_DEVICE_TOKEN=${result.deviceToken}`,
    "",
  ].join("\n"),
  { encoding: "utf8", mode: 0o600 },
);
await chmod(outputPath, 0o600);
console.log(`IoT Nano tenant ${process.env.IOT_NANO_TENANT_SLUG?.trim() || "tenant-cs"} is ready.`);
console.log(`Charge Station device: ${result.deviceId}`);
console.log(`Compose secrets written to ${outputPath}`);

function seedConfig(): IotNanoTenantProvisioningConfig {
  return {
    apiUrl: process.env.IOT_NANO_API_URL?.trim() || "http://127.0.0.1:17180",
    deviceName: process.env.IOT_NANO_DEVICE_NAME?.trim() || "Charge Station Demo Device",
    deviceSerialNumber: process.env.IOT_NANO_DEVICE_SERIAL?.trim() || "CS-DEMO-001",
    operatorPassword: requiredEnvironment("IOT_NANO_CS_OPERATOR_PASSWORD"),
    operatorUsername: process.env.IOT_NANO_CS_OPERATOR_USERNAME?.trim() || "cs-operator",
    systemPassword: requiredEnvironment("IOT_NANO_SYSTEM_PASSWORD"),
    systemUsername: requiredEnvironment("IOT_NANO_SYSTEM_USERNAME"),
    tenantPassword: requiredEnvironment("IOT_NANO_TENANT_PASSWORD"),
    tenantSlug: process.env.IOT_NANO_TENANT_SLUG?.trim() || "tenant-cs",
    tenantUsername: process.env.IOT_NANO_TENANT_USERNAME?.trim() || "tenant-cs",
    userPassword: requiredEnvironment("IOT_NANO_CS_ADMIN_PASSWORD"),
    userUsername: process.env.IOT_NANO_CS_ADMIN_USERNAME?.trim() || "cs-admin",
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  if (/\r|\n/.test(value)) throw new Error(`${name} cannot contain a line break`);
  return value;
}
