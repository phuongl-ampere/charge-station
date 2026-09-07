import { describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';

import { Connector, ConnectorsService } from './connectors.service';

describe('ConnectorsService', () => {
  it('returns an available connector with permitted durations and price', async () => {
    const repository = {
      findOneBy: vi.fn().mockResolvedValue({
        code: 'ST01-C01',
        status: 'AVAILABLE',
        station: { code: 'ST01', name: 'Demo Station' },
      }),
    } as unknown as Repository<Connector>;
    const service = new ConnectorsService(repository);

    await expect(service.getPublicConnector('ST01-C01')).resolves.toEqual({
      stationCode: 'ST01',
      connectorCode: 'ST01-C01',
      status: 'AVAILABLE',
      allowedDurationsMinutes: [60, 120, 180],
      hourlyPriceVnd: 5000,
    });
  });
});
