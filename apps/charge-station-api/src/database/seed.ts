import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import {
  appDataSource,
  Connector,
  ConnectorStatus,
  PricingPlan,
  Station,
} from './data-source.js';

export async function seedDatabase(dataSource = appDataSource): Promise<void> {
  const shouldClose = !dataSource.isInitialized;
  if (shouldClose) {
    await dataSource.initialize();
  }

  try {
    await dataSource.runMigrations();

    const stationRepository = dataSource.getRepository(Station);
    const pricingRepository = dataSource.getRepository(PricingPlan);
    const connectorRepository = dataSource.getRepository(Connector);

    let station = await stationRepository.findOneBy({ code: 'ST01' });
    if (!station) {
      station = await stationRepository.save(
        stationRepository.create({
          id: randomUUID(),
          code: 'ST01',
          name: 'Demo Station',
          deviceId: 'dev_ST01',
        }),
      );
    }

    let pricingPlan = await pricingRepository.findOneBy({ name: 'MVP hourly pricing' });
    if (!pricingPlan) {
      pricingPlan = await pricingRepository.save(
        pricingRepository.create({
          id: randomUUID(),
          name: 'MVP hourly pricing',
          hourlyPriceVnd: 5000,
          allowedDurationsMinutes: [60, 120, 180],
        }),
      );
    }

    const connector = await connectorRepository.findOneBy({ code: 'ST01-C01' });
    if (!connector) {
      await connectorRepository.save(
        connectorRepository.create({
          id: randomUUID(),
          code: 'ST01-C01',
          status: ConnectorStatus.AVAILABLE,
          station,
          pricingPlan,
        }),
      );
    }
  } finally {
    if (shouldClose) {
      await dataSource.destroy();
    }
  }
}

export function isSeedEntrypoint(entrypoint: string | undefined): boolean {
  return entrypoint ? ['seed.ts', 'seed.js'].includes(basename(entrypoint)) : false;
}

if (isSeedEntrypoint(process.argv[1])) {
  void seedDatabase().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
