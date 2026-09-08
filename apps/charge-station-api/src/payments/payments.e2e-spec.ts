import { randomUUID } from 'node:crypto';

import { Logger, ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataType, newDb } from 'pg-mem';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
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
import { ChargeGateway } from '../realtime/charge.gateway.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';

describe('PayOS payment API', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let payosClient: PayosClient;
  const chargeGateway = {
    issueAccessToken: vi.fn((orderId: string) => `capability-${orderId}`),
    publishOrder: vi.fn(),
    publishSession: vi.fn(),
  };

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
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
    dataSource = database.adapters.createTypeormDataSource({
      type: 'postgres',
      entities,
      migrations,
      migrationsRun: false,
    }) as DataSource;
    await dataSource.initialize();
    await dataSource.runMigrations();

    const station = await dataSource.getRepository(Station).save({
      id: randomUUID(),
      code: 'ST01',
      name: 'Demo Station',
      deviceId: 'dev_ST01',
    });
    const pricingPlan = await dataSource.getRepository(PricingPlan).save({
      id: randomUUID(),
      name: 'MVP hourly pricing',
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

    payosClient = new PayosClient({
      mode: 'mock',
      clientId: 'client-id',
      apiKey: 'api-key',
      checksumKey: 'checksum-key',
      returnUrl: 'http://localhost:5173/charge/return',
      cancelUrl: 'http://localhost:5173/charge/cancel',
    });
    const module = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [
        PaymentsService,
        { provide: PayosClient, useValue: payosClient },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: ChargeGateway, useValue: chargeGateway },
      ],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
    await dataSource.destroy();
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM "device_commands"');
    await dataSource.query('DELETE FROM "charging_sessions"');
    await dataSource.query('DELETE FROM "payment_transactions"');
    await dataSource.query('DELETE FROM "orders"');
    await dataSource
      .getRepository(Connector)
      .update({ code: 'ST01-C01' }, { status: ConnectorStatus.AVAILABLE });
  });

  it('creates a pending order with a deterministic local checkout URL', async () => {
    const response = await createOrder();

    expect(response.body).toMatchObject({
      amount: 10000,
      currency: 'VND',
      payment: {
        provider: 'PAYOS',
        checkoutUrl: expect.stringMatching(
          /^http:\/\/localhost:4000\/payments\/payos\/mock\/\d+$/,
        ),
      },
    });

    const payment = await dataSource.getRepository(PaymentTransaction).findOne({
      where: { order: { id: response.body.orderId } },
      relations: { order: true },
    });
    expect(payment).toMatchObject({
      status: PaymentTransactionStatus.PENDING,
      checkoutUrl: response.body.payment.checkoutUrl,
    });
    expect(payment?.order.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(
      (
        await dataSource
          .getRepository(Connector)
          .findOneByOrFail({ code: 'ST01-C01' })
      ).status,
    ).toBe(ConnectorStatus.OCCUPIED);
  });

  it('serves a local checkout page that can complete a mock payment', async () => {
    const created = await createOrder();
    const order = await dataSource
      .getRepository(Order)
      .findOneByOrFail({ id: created.body.orderId });
    const checkoutPath = new URL(created.body.payment.checkoutUrl).pathname;

    await request(app.getHttpServer())
      .get(checkoutPath)
      .expect('Content-Type', /text\/html/)
      .expect(new RegExp(`action="${checkoutPath}/complete"`))
      .expect(new RegExp(`action="${checkoutPath}/cancel"`))
      .expect(200);
    await request(app.getHttpServer())
      .post(`${checkoutPath}/complete`)
      .expect(201);

    expect(
      (await dataSource.getRepository(Order).findOneByOrFail({ id: order.id }))
        .status,
    ).toBe(OrderStatus.PAID);
    expect(
      (
        await dataSource
          .getRepository(Connector)
          .findOneByOrFail({ code: 'ST01-C01' })
      ).status,
    ).toBe(ConnectorStatus.OCCUPIED);
    expect(
      await dataSource
        .getRepository(ChargingSession)
        .countBy({ order: { id: order.id } }),
    ).toBe(1);
  });

  it('releases a reserved connector when local checkout is cancelled', async () => {
    const created = await createOrder();
    const checkoutPath = new URL(created.body.payment.checkoutUrl).pathname;

    await request(app.getHttpServer())
      .post(`${checkoutPath}/cancel`)
      .expect(201);

    expect(
      (
        await dataSource
          .getRepository(Connector)
          .findOneByOrFail({ code: 'ST01-C01' })
      ).status,
    ).toBe(ConnectorStatus.AVAILABLE);
    await createOrder();
  });

  it('expires an abandoned local checkout and releases its connector', async () => {
    const created = await createOrder();
    const payment = await dataSource
      .getRepository(PaymentTransaction)
      .findOneOrFail({
        where: { order: { id: created.body.orderId } },
        relations: { order: true },
      });
    await dataSource.getRepository(PaymentTransaction).update(payment.id, {
      expiresAt: new Date(Date.now() - 1),
    });
    const paymentsService = app.get(PaymentsService);

    await expect(paymentsService.expireDueReservations()).resolves.toBe(1);

    const checkoutPath = new URL(created.body.payment.checkoutUrl).pathname;
    await request(app.getHttpServer())
      .get(checkoutPath)
      .expect('Content-Type', /text\/html/)
      .expect(/Payment status: EXPIRED/)
      .expect(200);
    await request(app.getHttpServer())
      .post(`${checkoutPath}/complete`)
      .expect(201);

    expect(
      (
        await dataSource
          .getRepository(PaymentTransaction)
          .findOneByOrFail({ id: payment.id })
      ).status,
    ).toBe(PaymentTransactionStatus.EXPIRED);
    expect(
      (await dataSource.getRepository(Order).findOneByOrFail({ id: payment.order.id }))
        .status,
    ).toBe(OrderStatus.EXPIRED);
    expect(
      (
        await dataSource
          .getRepository(Connector)
          .findOneByOrFail({ code: 'ST01-C01' })
      ).status,
    ).toBe(ConnectorStatus.AVAILABLE);
  });

  it('marks a signed paid webhook once and creates one session and start command', async () => {
    const created = await createOrder();
    const order = await dataSource
      .getRepository(Order)
      .findOneByOrFail({ id: created.body.orderId });
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

    await request(app.getHttpServer())
      .post('/payments/payos/webhook')
      .send(body)
      .expect(201);
    await request(app.getHttpServer())
      .post('/payments/payos/webhook')
      .send(body)
      .expect(201);

    expect(
      await dataSource
        .getRepository(ChargingSession)
        .countBy({ order: { id: order.id } }),
    ).toBe(1);
    expect(await dataSource.getRepository(DeviceCommand).count()).toBe(1);
    expect(
      (await dataSource.getRepository(Order).findOneByOrFail({ id: order.id }))
        .status,
    ).toBe(OrderStatus.PAID);
  });

  it('rejects invalid signatures, unknown orders, and amount mismatches without starting charging', async () => {
    const beforeSessions = await dataSource
      .getRepository(ChargingSession)
      .count();
    const beforeCommands = await dataSource
      .getRepository(DeviceCommand)
      .count();
    const created = await createOrder();
    const order = await dataSource
      .getRepository(Order)
      .findOneByOrFail({ id: created.body.orderId });
    const validData: PayosWebhookData = {
      orderCode: Number(order.payosOrderCode),
      amount: order.amountVnd,
      status: 'PAID',
    };

    await request(app.getHttpServer())
      .post('/payments/payos/webhook')
      .send({
        code: '00',
        success: true,
        data: validData,
        signature: 'not-valid',
      })
      .expect(400);
    await request(app.getHttpServer())
      .post('/payments/payos/webhook')
      .send({
        code: '00',
        success: true,
        data: { ...validData, orderCode: 999999 },
        signature: payosClient.signWebhook({ ...validData, orderCode: 999999 }),
      })
      .expect(404);
    await request(app.getHttpServer())
      .post('/payments/payos/webhook')
      .send({
        code: '00',
        success: true,
        data: { ...validData, amount: validData.amount + 1 },
        signature: payosClient.signWebhook({
          ...validData,
          amount: validData.amount + 1,
        }),
      })
      .expect(400);

    expect(await dataSource.getRepository(ChargingSession).count()).toBe(
      beforeSessions,
    );
    expect(await dataSource.getRepository(DeviceCommand).count()).toBe(
      beforeCommands,
    );
    expect(
      (await dataSource.getRepository(Order).findOneByOrFail({ id: order.id }))
        .status,
    ).toBe(OrderStatus.PENDING_PAYMENT);
  });

  it('returns 400 for malformed webhook data and signatures', async () => {
    const created = await createOrder();
    const order = await dataSource
      .getRepository(Order)
      .findOneByOrFail({ id: created.body.orderId });
    const validData: PayosWebhookData = {
      orderCode: Number(order.payosOrderCode),
      amount: order.amountVnd,
      status: 'PAID',
    };

    await request(app.getHttpServer())
      .post('/payments/payos/webhook')
      .send({ code: '00', success: true, data: null, signature: 'not-valid' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/payments/payos/webhook')
      .send({
        code: '00',
        success: true,
        data: { ...validData, amount: '10000' },
        signature: payosClient.signWebhook({ ...validData, amount: '10000' }),
      })
      .expect(400);
    await request(app.getHttpServer())
      .post('/payments/payos/webhook')
      .send({
        code: '00',
        success: true,
        data: validData,
        signature: { invalid: true },
      })
      .expect(400);

    expect(
      (await dataSource.getRepository(Order).findOneByOrFail({ id: order.id }))
        .status,
    ).toBe(OrderStatus.PENDING_PAYMENT);
  });

  it('persists a cancelled payment without creating charging work', async () => {
    const created = await createOrder();
    const order = await dataSource
      .getRepository(Order)
      .findOneByOrFail({ id: created.body.orderId });
    const data: PayosWebhookData = {
      orderCode: Number(order.payosOrderCode),
      amount: order.amountVnd,
      paymentLinkId: `mock_${order.payosOrderCode}`,
      status: 'CANCELLED',
    };

    await request(app.getHttpServer())
      .post('/payments/payos/webhook')
      .send({
        code: '01',
        success: false,
        data,
        signature: payosClient.signWebhook(data),
      })
      .expect(201);

    expect(
      (await dataSource.getRepository(Order).findOneByOrFail({ id: order.id }))
        .status,
    ).toBe(OrderStatus.PAYMENT_FAILED);
    expect(
      (
        await dataSource
          .getRepository(PaymentTransaction)
          .findOneByOrFail({ order: { id: order.id } })
      ).status,
    ).toBe(PaymentTransactionStatus.FAILED);
    expect(
      await dataSource
        .getRepository(ChargingSession)
        .countBy({ order: { id: order.id } }),
    ).toBe(0);
  });

  it('redirects signed return and cancel callbacks without changing payment state', async () => {
    const created = await createOrder();
    const order = await dataSource
      .getRepository(Order)
      .findOneByOrFail({ id: created.body.orderId });
    const callbackData = { orderCode: Number(order.payosOrderCode) };
    const signature = payosClient.signWebhook(callbackData);

    const returnResponse = await request(app.getHttpServer())
      .get('/payments/payos/return')
      .query({ ...callbackData, signature })
      .expect(302);
    const cancelResponse = await request(app.getHttpServer())
      .get('/payments/payos/cancel')
      .query({ ...callbackData, signature })
      .expect(302);
    for (const response of [returnResponse, cancelResponse]) {
      const redirect = new URL(response.headers.location);
      expect(redirect.origin).toBe('http://localhost:5173');
      expect(redirect.pathname).toBe(`/charge/${order.id}`);
      expect(redirect.search).toBe('');
      expect(
        new URLSearchParams(redirect.hash.slice(1)).get('charge_access'),
      ).toBe(`capability-${order.id}`);
    }
    expect(chargeGateway.issueAccessToken).toHaveBeenCalledWith(order.id);
    await request(app.getHttpServer())
      .get('/payments/payos/return')
      .query({ ...callbackData, signature: 'invalid' })
      .expect(400);
    await request(app.getHttpServer())
      .get('/payments/payos/cancel')
      .query(callbackData)
      .expect(400);

    expect(
      (await dataSource.getRepository(Order).findOneByOrFail({ id: order.id }))
        .status,
    ).toBe(OrderStatus.PENDING_PAYMENT);
    expect(
      await dataSource
        .getRepository(ChargingSession)
        .countBy({ order: { id: order.id } }),
    ).toBe(0);
  });

  async function createOrder() {
    return request(app.getHttpServer())
      .post('/orders')
      .send({ connectorCode: 'ST01-C01', durationMinutes: 120 })
      .expect(201);
  }
});
