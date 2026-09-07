import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';

import {
  ChargingSession,
  Connector,
  DeviceCommand,
  Order,
  OrderStatus,
  PaymentTransaction,
  PaymentTransactionStatus,
} from '../database/data-source.js';
import type { PayosClient } from './payos.client.js';
import type { PayosWebhook } from './payos.client.js';
import { PaymentsService } from './payments.service.js';

describe('PaymentsService webhook processing', () => {
  it('marks the order paid and creates exactly one start command for a valid webhook', async () => {
    const pendingOrder = {
      id: randomUUID(),
      payosOrderCode: '100001',
      amountVnd: 10000,
      durationMinutes: 120,
      status: OrderStatus.PENDING_PAYMENT,
      connector: {
        id: randomUUID(),
        code: 'ST01-C01',
        station: { deviceId: 'dev_ST01' },
      },
    } as Order;
    const payment = {
      id: randomUUID(),
      status: PaymentTransactionStatus.PENDING,
      order: pendingOrder,
    } as PaymentTransaction;
    const paymentRepository = {
      findOne: vi.fn().mockResolvedValue(payment),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const orderRepository = {
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const connectorRepository = {
      findOne: vi.fn().mockResolvedValue(pendingOrder.connector),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const sessionRepository = {
      create: vi.fn().mockImplementation((entity) => entity),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const commandRepository = {
      create: vi.fn().mockImplementation((entity) => entity),
      save: vi.fn().mockImplementation(async (entity) => entity),
    };
    const manager = {
      query: vi.fn().mockImplementation(async (query: string) => {
        if (query.includes('FROM payment_transactions'))
          return [{ id: payment.id }];
        if (query.includes('FROM connectors'))
          return [{ id: pendingOrder.connector.id }];
        throw new Error('Unexpected lock query');
      }),
      getRepository: vi.fn((entity) => {
        if (entity === PaymentTransaction) return paymentRepository;
        if (entity === Order) return orderRepository;
        if (entity === Connector) return connectorRepository;
        if (entity === ChargingSession) return sessionRepository;
        if (entity === DeviceCommand) return commandRepository;
        throw new Error('Unexpected repository');
      }),
    };
    const dataSource = {
      transaction: vi.fn(async (callback) => callback(manager)),
    };
    const client = {
      verifyWebhook: vi.fn().mockReturnValue(true),
    };
    const service = new PaymentsService(
      dataSource as unknown as DataSource,
      client as unknown as PayosClient,
    );
    const body: PayosWebhook = {
      code: '00',
      success: true,
      signature: 'valid',
      data: {
        orderCode: 100001,
        amount: 10000,
        paymentLinkId: 'pl_123',
        status: 'PAID',
      },
    };

    await service.handleWebhook(body);
    await service.handleWebhook(body);

    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM payment_transactions'),
      ['100001'],
    );
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM connectors'),
      [pendingOrder.connector.id],
    );
    expect(orderRepository.save).toHaveBeenCalledTimes(1);
    expect(paymentRepository.save).toHaveBeenCalledTimes(1);
    expect(sessionRepository.save).toHaveBeenCalledTimes(1);
    expect(commandRepository.save).toHaveBeenCalledTimes(1);
    expect(pendingOrder.status).toBe(OrderStatus.PAID);
    expect(payment.status).toBe(PaymentTransactionStatus.PAID);
    expect(payment.paymentLinkId).toBe('pl_123');
    expect(commandRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ commandType: 'START_CHARGING' }),
    );
  });

  it('does not open a database transaction for an invalid signature', async () => {
    const dataSource = { transaction: vi.fn() };
    const client = { verifyWebhook: vi.fn().mockReturnValue(false) };
    const service = new PaymentsService(
      dataSource as unknown as DataSource,
      client as unknown as PayosClient,
    );

    await expect(
      service.handleWebhook({
        code: '00',
        success: true,
        signature: 'invalid',
        data: { orderCode: 100001, amount: 10000 },
      }),
    ).rejects.toThrow('Invalid PayOS webhook signature');

    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});
