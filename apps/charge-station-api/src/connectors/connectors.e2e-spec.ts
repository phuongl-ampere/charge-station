import { randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataType, newDb } from "pg-mem";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataSource, Repository } from "typeorm";

import {
  Connector,
  ConnectorStatus,
  PricingPlan,
  Station,
} from "../database/data-source.js";
import { ConnectorsController } from "./connectors.controller.js";
import { ConnectorsService } from "./connectors.service.js";

describe("public connector API", () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    const database = newDb({ autoCreateForeignKeyIndices: true });
    database.public.registerFunction({
      name: "version",
      returns: DataType.text,
      implementation: () => "PostgreSQL 16.0",
    });
    database.public.registerFunction({
      name: "current_database",
      returns: DataType.text,
      implementation: () => "charge_station_test",
    });
    dataSource = database.adapters.createTypeormDataSource({
      type: "postgres",
      entities: [Station, PricingPlan, Connector],
      synchronize: true,
    }) as DataSource;
    await dataSource.initialize();

    const station = await dataSource.getRepository(Station).save({
      id: randomUUID(),
      code: "ST01",
      name: "Demo Station",
    });
    const pricingPlan = await dataSource.getRepository(PricingPlan).save({
      id: randomUUID(),
      name: "MVP hourly pricing",
      hourlyPriceVnd: 5000,
      allowedDurationsMinutes: [60, 120, 180],
    });
    await dataSource.getRepository(Connector).save({
      id: randomUUID(),
      code: "ST01-C01",
      status: ConnectorStatus.AVAILABLE,
      station,
      pricingPlan,
    });

    const module = await Test.createTestingModule({
      controllers: [ConnectorsController],
      providers: [
        ConnectorsService,
        {
          provide: getRepositoryToken(Connector),
          useValue: dataSource.getRepository(
            Connector,
          ) as Repository<Connector>,
        },
      ],
    }).compile();

    const nestApp = module.createNestApplication();
    await nestApp.init();
    app = nestApp;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it("returns seeded connector availability and pricing", async () => {
    const response = await request(app.getHttpServer())
      .get("/public/connectors/ST01-C01")
      .expect(200);

    expect(response.body).toEqual({
      stationCode: "ST01",
      connectorCode: "ST01-C01",
      status: "AVAILABLE",
      allowedDurationsMinutes: [60, 120, 180],
      hourlyPriceVnd: 5000,
    });
  });
});
