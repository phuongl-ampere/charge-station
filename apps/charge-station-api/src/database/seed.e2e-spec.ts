import { DataType, newDb } from 'pg-mem';
import { afterAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';

import {
  Connector,
  ConnectorStatus,
  entities,
  migrations,
  PricingPlan,
  Station,
} from './data-source.js';
import { isSeedEntrypoint, seedDatabase } from './seed.js';

function createPgMemDataSource(): DataSource {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  database.public.registerFunction({
    name: 'version',
    returns: DataType.text,
    implementation: () => 'PostgreSQL 16.0',
  });
  database.public.registerFunction({
    name: 'current_database',
    returns: DataType.text,
    implementation: () => 'charge_station_test',
  });

  return database.adapters.createTypeormDataSource({
    type: 'postgres',
    entities,
    migrations,
    migrationsRun: false,
  }) as DataSource;
}

describe('database seed lifecycle', () => {
  let dataSource: DataSource;

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('recognizes the compiled JavaScript seed entrypoint', () => {
    expect(isSeedEntrypoint('/app/dist/database/seed.js')).toBe(true);
    expect(isSeedEntrypoint('/app/src/database/seed.ts')).toBe(true);
  });

  it('runs migrations and seeds an idempotent pg-mem database lifecycle', async () => {
    dataSource = createPgMemDataSource();

    await seedDatabase(dataSource);
    await seedDatabase(dataSource);
    await dataSource.initialize();

    const station = await dataSource.getRepository(Station).findOneBy({ code: 'ST01' });
    const pricingPlan = await dataSource
      .getRepository(PricingPlan)
      .findOneBy({ name: 'MVP hourly pricing' });
    const connector = await dataSource
      .getRepository(Connector)
      .findOneBy({ code: 'ST01-C01' });
    const migrations = await dataSource.query('SELECT * FROM "migrations"');

    expect(migrations).toHaveLength(7);
    expect(station).toMatchObject({
      code: 'ST01',
      name: 'Demo Station',
      deviceId: 'dev_ST01',
    });
    expect(pricingPlan).toMatchObject({
      name: 'MVP hourly pricing',
      hourlyPriceVnd: 5000,
      allowedDurationsMinutes: [60, 120, 180],
    });
    expect(connector).toMatchObject({
      code: 'ST01-C01',
      status: ConnectorStatus.AVAILABLE,
    });
    expect(connector?.station.code).toBe('ST01');
    expect(connector?.pricingPlan?.name).toBe('MVP hourly pricing');
    expect(await dataSource.getRepository(Station).count()).toBe(1);
    expect(await dataSource.getRepository(PricingPlan).count()).toBe(1);
    expect(await dataSource.getRepository(Connector).count()).toBe(1);
  });
});
