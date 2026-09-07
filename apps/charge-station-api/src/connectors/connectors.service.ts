import { InjectRepository } from '@nestjs/typeorm';
import { NotFoundException, Injectable } from '@nestjs/common';
import { HOURLY_PRICE_VND } from '@charge-station/contracts';
import { Repository } from 'typeorm';

import { Connector } from '../database/data-source.js';

export { Connector };

@Injectable()
export class ConnectorsService {
  constructor(
    @InjectRepository(Connector)
    private readonly repository: Repository<Connector>,
  ) {}

  async getPublicConnector(connectorCode: string) {
    const connector = await this.repository.findOneBy({ code: connectorCode });
    if (!connector) {
      throw new NotFoundException('Connector not found');
    }

    const pricingPlan = connector.pricingPlan;
    return {
      stationCode: connector.station.code,
      connectorCode: connector.code,
      status: connector.status,
      allowedDurationsMinutes: pricingPlan?.allowedDurationsMinutes ?? [60, 120, 180],
      hourlyPriceVnd: pricingPlan?.hourlyPriceVnd ?? HOURLY_PRICE_VND,
    };
  }
}
