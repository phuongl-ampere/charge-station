import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DataSource } from 'typeorm';

import {
  ChargingSession,
  Connector,
  ConnectorStatus,
  DeviceCommand,
  entities,
  migrations,
  Order,
  OrderStatus,
  PaymentTransaction,
  PaymentTransactionStatus,
  PricingPlan,
  Station,
} from '../database/data-source.js';
import { PayosClient, type PayosWebhookData } from './payos.client.js';
import { PaymentsService } from './payments.service.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://charge:charge@localhost:5432/charge_station';
const schema = `task4_payments_${randomUUID().replaceAll('-', '')}`;

describe('PayOS payment concurrency with local PostgreSQL', () => {
  let adminDataSource: DataSource;
  let dataSource: DataSource;
  let paymentsService: PaymentsService;
  let payosClient: PayosClient;
  let createdOrderId: string;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    adminDataSource = new DataSource({ type: 'postgres', url: databaseUrl });
    await adminDataSource.initialize();
    await adminDataSource.query(`CREATE SCHEMA "${schema}"`);

    dataSource = new DataSource({
      type: 'postgres',
      url: databaseUrl,
      entities,
      migrations,
      migrationsRun: false,
      extra: { options: `-c search_path=${schema},public` },
    });
    await dataSource.initialize();
    await dataSource.runMigrations();

    const station = await dataSource.getRepository(Station).save({
      id: randomUUID(),
      code: 'ST01',
      name: 'PostgreSQL Test Station',
      deviceId: 'dev_ST01',
    });
    const pricingPlan = await dataSource.getRepository(PricingPlan).save({
      id: randomUUID(),
      name: 'PostgreSQL Test Pricing',
      hourlyPriceVnd: 5000,
      allowedDurationsMinutes: [60, 120, 180],
    });
    await dataSource.getRepository(Connector).save({
      id: randomUUID(),
      code: 'ST01-C01',
      status: ConnectorStatus.AVAILABLE,
      station,
      pricingPlan,
    });
    await dataSource.getRepository(Connector).save({
      id: randomUUID(),
      code: 'ST01-C02',
      status: ConnectorStatus.AVAILABLE,
      station,
      pricingPlan,
    });

    payosClient = new PayosClient({
      mode: 'mock',
      clientId: 'client-id',
      apiKey: 'api-key',
      checksumKey: 'checksum-key',
      returnUrl: 'http://localhost:5173/charge/return',
      cancelUrl: 'http://localhost:5173/charge/cancel',
    });
    paymentsService = new PaymentsService(dataSource, payosClient);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    if (adminDataSource?.isInitialized) {
      await adminDataSource.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await adminDataSource.destroy();
    }
  });

  it('compensates a rejected provider link and allows the connector to be ordered again', async () => {
    const createPaymentLink = vi
      .spyOn(payosClient, 'createPaymentLink')
      .mockRejectedValueOnce(new Error('PayOS provider unavailable'));

    await expect(
      paymentsService.createOrder({
        connectorCode: 'ST01-C02',
        durationMinutes: 60,
      }),
    ).rejects.toThrow('PayOS provider unavailable');

    const failedPayment = await dataSource
      .getRepository(PaymentTransaction)
      .findOneOrFail({
        where: { order: { connector: { code: 'ST01-C02' } } },
        relations: { order: { connector: true } },
      });

    expect(failedPayment.status).toBe(PaymentTransactionStatus.FAILED);
    expect(failedPayment.checkoutUrl).toBeNull();
    expect(failedPayment.order.status).toBe(OrderStatus.PAYMENT_FAILED);
    expect(failedPayment.order.connector.status).toBe(
      ConnectorStatus.AVAILABLE,
    );

    await expect(
      paymentsService.createOrder({
        connectorCode: 'ST01-C02',
        durationMinutes: 60,
      }),
    ).resolves.toMatchObject({
      payment: {
        provider: 'PAYOS',
        checkoutUrl: expect.any(String),
      },
    });
    expect(createPaymentLink).toHaveBeenCalledTimes(2);
  });

  it('allows exactly one concurrent pending order to reserve a connector', async () => {
    const results = await Promise.allSettled([
      paymentsService.createOrder({
        connectorCode: 'ST01-C01',
        durationMinutes: 120,
      }),
      paymentsService.createOrder({
        connectorCode: 'ST01-C01',
        durationMinutes: 120,
      }),
    ]);

    const successfulResult = results.find(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<PaymentsService['createOrder']>>
      > => result.status === 'fulfilled',
    );

    expect(successfulResult).toBeDefined();
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    createdOrderId = successfulResult!.value.orderId;
    expect(
      await dataSource.getRepository(Order).count({
        where: { connector: { code: 'ST01-C01' } },
      }),
    ).toBe(1);
    expect(
      (
        await dataSource
          .getRepository(Connector)
          .findOneByOrFail({ code: 'ST01-C01' })
      ).status,
    ).toBe(ConnectorStatus.OCCUPIED);
  });

  it('creates one charging session and command for concurrent duplicate paid webhooks', async () => {
    const order = await dataSource
      .getRepository(Order)
      .findOneByOrFail({ id: createdOrderId });
    const data: PayosWebhookData = {
      orderCode: Number(order.payosOrderCode),
      amount: order.amountVnd,
      paymentLinkId: `mock_${order.payosOrderCode}`,
      status: 'PAID',
    };
    const body = {
      code: '00',
      success: true,
      data,
      signature: payosClient.signWebhook(data),
    };

    await Promise.all([
      paymentsService.handleWebhook(body),
      paymentsService.handleWebhook(body),
    ]);

    expect(
      await dataSource.getRepository(PaymentTransaction).count({
        where: { order: { id: order.id } },
      }),
    ).toBe(1);
    expect(
      await dataSource
        .getRepository(ChargingSession)
        .countBy({ order: { id: order.id } }),
    ).toBe(1);
    expect(await dataSource.getRepository(DeviceCommand).count()).toBe(1);
  });
});
