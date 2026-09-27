import "reflect-metadata";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { Repository } from "typeorm";

import {
  appDataSource,
  Connector,
  ConnectorStatus,
  DeviceAvailability,
  ManagedDevice,
  PricingPlan,
  Station,
  User,
  UserRole,
} from "./data-source.js";

export async function seedDatabase(dataSource = appDataSource): Promise<void> {
  const shouldClose = !dataSource.isInitialized;
  if (shouldClose) {
    await dataSource.initialize();
  }

  try {
    await dataSource.runMigrations();

    const stationRepository = dataSource.getRepository(Station);
    const deviceRepository = dataSource.getRepository(ManagedDevice);
    const pricingRepository = dataSource.getRepository(PricingPlan);
    const connectorRepository = dataSource.getRepository(Connector);
    const userRepository = dataSource.getRepository(User);

    let station = await stationRepository.findOneBy({ code: "ST01" });
    if (!station) {
      station = await stationRepository.save(
        stationRepository.create({
          id: randomUUID(),
          code: "ST01",
          name: "Demo Station",
          deviceId: "dev_ST01",
        }),
      );
    }
    const coreDeviceId = process.env.IOT_CORE_DEVICE_ID?.trim();
    if (coreDeviceId && station.deviceId !== coreDeviceId) {
      station.deviceId = coreDeviceId;
      station = await stationRepository.save(station);
    }
    if (station.deviceId && !(await deviceRepository.findOneBy({ deviceId: station.deviceId }))) {
      await deviceRepository.save(
        deviceRepository.create({
          deviceId: station.deviceId,
          availability: DeviceAvailability.AVAILABLE,
        }),
      );
    }

    let pricingPlan = await pricingRepository.findOneBy({
      name: "MVP hourly pricing",
    });
    if (!pricingPlan) {
      pricingPlan = await pricingRepository.save(
        pricingRepository.create({
          id: randomUUID(),
          name: "MVP hourly pricing",
          hourlyPriceVnd: 5000,
          allowedDurationsMinutes: [60, 120, 180],
        }),
      );
    }

    const connector = await connectorRepository.findOneBy({ code: "ST01-C01" });
    if (!connector) {
      await connectorRepository.save(
        connectorRepository.create({
          id: randomUUID(),
          code: "ST01-C01",
          status: ConnectorStatus.AVAILABLE,
          station,
          pricingPlan,
        }),
      );
    }

    await seedOperationsAdmin(userRepository);
  } finally {
    if (shouldClose) {
      await dataSource.destroy();
    }
  }
}

async function seedOperationsAdmin(
  userRepository: Repository<User>,
): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    return;
  }

  const existing = await userRepository.findOneBy({ email });
  if (existing) {
    return;
  }

  await userRepository.save(
    userRepository.create({
      id: randomUUID(),
      email,
      passwordHash: await bcrypt.hash(password, 12),
      role: UserRole.ADMIN,
    }),
  );
}

export function isSeedEntrypoint(entrypoint: string | undefined): boolean {
  return entrypoint
    ? ["seed.ts", "seed.js"].includes(basename(entrypoint))
    : false;
}

if (isSeedEntrypoint(process.argv[1])) {
  void seedDatabase().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
