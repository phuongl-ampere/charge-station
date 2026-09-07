import { Controller, Get, Inject, Param } from '@nestjs/common';

import { ConnectorsService } from './connectors.service.js';

@Controller('public/connectors')
export class ConnectorsController {
  constructor(
    @Inject(ConnectorsService)
    private readonly connectorsService: ConnectorsService,
  ) {}

  @Get(':connectorCode')
  getPublicConnector(@Param('connectorCode') connectorCode: string) {
    return this.connectorsService.getPublicConnector(connectorCode);
  }
}
