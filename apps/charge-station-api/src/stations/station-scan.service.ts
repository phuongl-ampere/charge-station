import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { HOURLY_PRICE_VND } from "@charge-station/contracts";
import type { Repository } from "typeorm";

import { Connector, Station } from "../database/data-source.js";
import { InvalidStationQrError, StationQrService } from "./station-qr.service.js";

@Injectable()
export class StationScanService {
  constructor(
    @InjectRepository(Station)
    private readonly stationRepository: Repository<Station>,
    @InjectRepository(Connector)
    private readonly connectorRepository: Repository<Connector>,
    private readonly stationQrService: StationQrService,
  ) {}

  async getStationScan(token: string) {
    let payload: { stationId: string; qrVersion: number };
    try {
      payload = await this.stationQrService.resolve(token);
    } catch (error) {
      if (error instanceof InvalidStationQrError) {
        throw unavailableStationQr();
      }
      throw error;
    }
    const station = await this.stationRepository.findOneBy({
      id: payload.stationId,
    });
    if (!station || station.qrVersion !== payload.qrVersion) {
      throw unavailableStationQr();
    }

    const connectors = await this.connectorRepository.find({
      where: { station: { id: station.id } },
      order: { code: "ASC" },
    });

    return {
      stationName: station.name,
      connectors: connectors.map((connector) => ({
        connectorCode: connector.code,
        status: connector.status,
        allowedDurationsMinutes:
          connector.pricingPlan?.allowedDurationsMinutes ?? [60, 120, 180],
        hourlyPriceVnd:
          connector.pricingPlan?.hourlyPriceVnd ?? HOURLY_PRICE_VND,
      })),
    };
  }
}

function unavailableStationQr(): NotFoundException {
  return new NotFoundException("Station QR is invalid or no longer active");
}
