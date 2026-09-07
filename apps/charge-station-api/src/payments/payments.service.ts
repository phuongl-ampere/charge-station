import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import {
  ChargingSession,
  ChargingSessionStatus,
  Connector,
  ConnectorStatus,
  DeviceCommand,
  DeviceCommandStatus,
  Order,
  OrderStatus,
  PaymentTransaction,
  PaymentTransactionStatus,
} from '../database/data-source.js';
import { PayosClient } from './payos.client.js';
import type { CreateOrderDto } from './dto/create-order.dto.js';
import { parsePayosWebhook } from './payos-webhook.js';

@Injectable()
export class PaymentsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(PayosClient) private readonly payosClient: PayosClient,
  ) {}

  async createOrder(input: CreateOrderDto): Promise<{
    orderId: string;
    amount: number;
    currency: string;
    payment: { provider: 'PAYOS'; checkoutUrl: string };
  }> {
    if (
      !Number.isInteger(input.durationMinutes) ||
      input.durationMinutes <= 0 ||
      input.durationMinutes % 60
    ) {
      throw new BadRequestException(
        'Charging duration must be a positive whole number of hours',
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const connectorRepository = manager.getRepository(Connector);
      const orderRepository = manager.getRepository(Order);
      const paymentRepository = manager.getRepository(PaymentTransaction);
      const connectorId = await lockConnectorIdByCode(
        manager,
        input.connectorCode,
      );
      const connector = connectorId
        ? await connectorRepository.findOne({
            where: { id: connectorId },
            relations: { pricingPlan: true },
          })
        : null;

      if (!connector) {
        throw new NotFoundException('Connector not found');
      }
      if (connector.status !== ConnectorStatus.AVAILABLE) {
        throw new BadRequestException('Connector is not available');
      }
      if (
        !connector.pricingPlan?.allowedDurationsMinutes.includes(
          input.durationMinutes,
        )
      ) {
        throw new BadRequestException(
          'Charging duration is not available for this connector',
        );
      }

      const amount = Math.round(
        connector.pricingPlan.hourlyPriceVnd * (input.durationMinutes / 60),
      );
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new BadRequestException(
          'Charging amount must be a positive whole VND amount',
        );
      }

      connector.status = ConnectorStatus.OCCUPIED;
      await connectorRepository.save(connector);

      const order = await orderRepository.save(
        orderRepository.create({
          id: randomUUID(),
          durationMinutes: input.durationMinutes,
          amountVnd: amount,
          currency: 'VND',
          status: OrderStatus.PENDING_PAYMENT,
          user: null,
          connector,
        }),
      );
      const orderCode = parsePositiveOrderCode(order.payosOrderCode);
      const payment = await paymentRepository.save(
        paymentRepository.create({
          id: randomUUID(),
          order,
          provider: 'PAYOS',
          paymentLinkId: null,
          checkoutUrl: null,
          status: PaymentTransactionStatus.PENDING,
          rawWebhookPayload: null,
          signatureValid: false,
        }),
      );
      const description = buildPaymentDescription(
        connector.code,
        input.durationMinutes,
      );
      const paymentLink = await this.payosClient.createPaymentLink({
        amount,
        orderCode,
        description,
        returnUrl: this.payosClient.returnUrl,
        cancelUrl: this.payosClient.cancelUrl,
      });

      payment.paymentLinkId = paymentLink.paymentLinkId;
      payment.checkoutUrl = paymentLink.checkoutUrl;
      await paymentRepository.save(payment);

      return {
        orderId: order.id,
        amount,
        currency: order.currency,
        payment: {
          provider: 'PAYOS',
          checkoutUrl: paymentLink.checkoutUrl,
        },
      };
    });
  }

  async handleWebhook(body: unknown): Promise<{ success: true }> {
    const webhook = parsePayosWebhook(body);
    if (!this.payosClient.verifyWebhook(webhook.data, webhook.signature)) {
      throw new BadRequestException('Invalid PayOS webhook signature');
    }

    const orderCode = parsePositiveOrderCode(webhook.data.orderCode);
    const amount = parsePositiveAmount(webhook.data.amount);

    return this.dataSource.transaction(async (manager) => {
      const paymentRepository = manager.getRepository(PaymentTransaction);
      const orderRepository = manager.getRepository(Order);
      const connectorRepository = manager.getRepository(Connector);
      const sessionRepository = manager.getRepository(ChargingSession);
      const commandRepository = manager.getRepository(DeviceCommand);
      const paymentId = await lockPaymentIdByOrderCode(manager, orderCode);
      const payment = paymentId
        ? await paymentRepository.findOne({
            where: { id: paymentId },
            relations: { order: { connector: { station: true } } },
          })
        : null;

      if (!payment) {
        throw new NotFoundException('PayOS order not found');
      }
      if (payment.status !== PaymentTransactionStatus.PENDING) {
        return { success: true };
      }
      if (amount !== payment.order.amountVnd) {
        throw new BadRequestException(
          'PayOS payment amount does not match the order',
        );
      }
      const connectorId = await lockConnectorIdById(
        manager,
        payment.order.connector.id,
      );
      const connector = connectorId
        ? await connectorRepository.findOne({ where: { id: connectorId } })
        : null;
      if (!connector) {
        throw new NotFoundException('Connector not found');
      }

      payment.rawWebhookPayload = webhook as unknown as Record<string, unknown>;
      payment.signatureValid = true;
      payment.paymentLinkId =
        typeof webhook.data.paymentLinkId === 'string'
          ? webhook.data.paymentLinkId
          : payment.paymentLinkId;

      if (webhook.code !== '00' || webhook.success !== true) {
        const expired = webhook.data.status === 'EXPIRED';
        payment.status = expired
          ? PaymentTransactionStatus.EXPIRED
          : PaymentTransactionStatus.FAILED;
        payment.order.status = expired
          ? OrderStatus.EXPIRED
          : OrderStatus.PAYMENT_FAILED;
        connector.status = ConnectorStatus.AVAILABLE;
        await orderRepository.save(payment.order);
        await paymentRepository.save(payment);
        await connectorRepository.save(connector);
        return { success: true };
      }

      payment.status = PaymentTransactionStatus.PAID;
      payment.order.status = OrderStatus.PAID;
      connector.status = ConnectorStatus.OCCUPIED;
      await orderRepository.save(payment.order);
      await paymentRepository.save(payment);
      await connectorRepository.save(connector);

      const session = sessionRepository.create({
        id: randomUUID(),
        order: payment.order,
        connector,
        status: ChargingSessionStatus.PENDING,
        startedAt: null,
        expectedEndAt: new Date(
          Date.now() + payment.order.durationMinutes * 60_000,
        ),
        stoppedAt: null,
      });
      const savedSession = await sessionRepository.save(session);
      const command = commandRepository.create({
        id: randomUUID(),
        commandId: randomUUID(),
        session: savedSession,
        commandType: 'START_CHARGING',
        payload: {
          connectorCode: connector.code,
          deviceId: payment.order.connector.station.deviceId,
          sessionId: savedSession.id,
        },
        retryCount: 0,
        status: DeviceCommandStatus.PENDING,
        acknowledgedAt: null,
      });
      await commandRepository.save(command);

      return { success: true };
    });
  }

  async getMockCheckout(orderCodeValue: unknown): Promise<{
    orderCode: number;
    amount: number;
    currency: string;
    status: PaymentTransactionStatus;
  }> {
    this.assertMockMode();
    const orderCode = parsePositiveOrderCode(orderCodeValue);
    const payment = await this.findPaymentForMockCheckout(orderCode);

    return {
      orderCode,
      amount: payment.order.amountVnd,
      currency: payment.order.currency,
      status: payment.status,
    };
  }

  async completeMockCheckout(
    orderCodeValue: unknown,
  ): Promise<{ success: true }> {
    return this.handleMockCheckout(orderCodeValue, 'PAID');
  }

  async cancelMockCheckout(
    orderCodeValue: unknown,
  ): Promise<{ success: true }> {
    return this.handleMockCheckout(orderCodeValue, 'CANCELLED');
  }

  async getCallbackRedirect(
    data: Record<string, unknown>,
    signature: string,
  ): Promise<string> {
    if (!this.payosClient.verifyWebhook(data, signature)) {
      throw new BadRequestException('Invalid PayOS callback signature');
    }

    const orderCode = parsePositiveOrderCode(data.orderCode);
    const order = await this.dataSource.getRepository(Order).findOneBy({
      payosOrderCode: String(orderCode),
    });
    if (!order) {
      throw new NotFoundException('PayOS order not found');
    }

    return `${(process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/$/, '')}/charge/${order.id}`;
  }

  private async handleMockCheckout(
    orderCodeValue: unknown,
    status: 'PAID' | 'CANCELLED',
  ): Promise<{ success: true }> {
    this.assertMockMode();
    const orderCode = parsePositiveOrderCode(orderCodeValue);
    const payment = await this.findPaymentForMockCheckout(orderCode);
    const data = {
      orderCode,
      amount: payment.order.amountVnd,
      paymentLinkId: payment.paymentLinkId ?? `mock_${orderCode}`,
      status,
    };

    return this.handleWebhook({
      code: status === 'PAID' ? '00' : '01',
      success: status === 'PAID',
      data,
      signature: this.payosClient.signWebhook(data),
    });
  }

  private async findPaymentForMockCheckout(
    orderCode: number,
  ): Promise<PaymentTransaction> {
    const payment = await this.dataSource
      .getRepository(PaymentTransaction)
      .findOne({
        where: { order: { payosOrderCode: String(orderCode) } },
        relations: { order: true },
      });
    if (!payment) {
      throw new NotFoundException('PayOS order not found');
    }
    return payment;
  }

  private assertMockMode(): void {
    if (!this.payosClient.isMock) {
      throw new BadRequestException('Mock PayOS checkout is disabled');
    }
  }
}

async function lockConnectorIdByCode(
  manager: EntityManager,
  code: string,
): Promise<string | null> {
  const rows = await manager.query(
    'SELECT id FROM connectors WHERE code = $1 FOR UPDATE',
    [code],
  );
  return rows[0]?.id ?? null;
}

async function lockConnectorIdById(
  manager: EntityManager,
  id: string,
): Promise<string | null> {
  const rows = await manager.query(
    'SELECT id FROM connectors WHERE id = $1 FOR UPDATE',
    [id],
  );
  return rows[0]?.id ?? null;
}

async function lockPaymentIdByOrderCode(
  manager: EntityManager,
  orderCode: number,
): Promise<string | null> {
  const rows = await manager.query(
    [
      'SELECT payment_transactions.id',
      'FROM payment_transactions',
      'INNER JOIN orders ON orders.id = payment_transactions.order_id',
      'WHERE orders.payos_order_code = $1',
      'FOR UPDATE',
    ].join(' '),
    [String(orderCode)],
  );
  return rows[0]?.id ?? null;
}

function parsePositiveOrderCode(value: unknown): number {
  const orderCode = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(orderCode) || orderCode <= 0) {
    throw new BadRequestException('PayOS order code must be a positive number');
  }
  return orderCode;
}

function parsePositiveAmount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new BadRequestException('PayOS amount must be a positive number');
  }
  return Math.round(value);
}

function buildPaymentDescription(
  connectorCode: string,
  durationMinutes: number,
): string {
  const connector = connectorCode.replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
  const description = `Charge ${connector} ${durationMinutes / 60}h`;
  if (description.length > 25) {
    throw new BadRequestException(
      'PayOS description exceeds 25 ASCII characters',
    );
  }
  return description.padEnd(25, ' ');
}
