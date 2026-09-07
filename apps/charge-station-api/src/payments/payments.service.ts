import { randomUUID } from 'node:crypto';

import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

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
import { PayosClient, type PayosWebhook } from './payos.client.js';
import type { CreateOrderDto } from './dto/create-order.dto.js';

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
    if (!Number.isInteger(input.durationMinutes) || input.durationMinutes <= 0 || input.durationMinutes % 60) {
      throw new BadRequestException('Charging duration must be a positive whole number of hours');
    }

    return this.dataSource.transaction(async (manager) => {
      const connectorRepository = manager.getRepository(Connector);
      const orderRepository = manager.getRepository(Order);
      const paymentRepository = manager.getRepository(PaymentTransaction);
      const connector = await connectorRepository.findOne({
        where: { code: input.connectorCode },
        relations: { pricingPlan: true },
      });

      if (!connector) {
        throw new NotFoundException('Connector not found');
      }
      if (connector.status !== ConnectorStatus.AVAILABLE) {
        throw new BadRequestException('Connector is not available');
      }
      if (!connector.pricingPlan?.allowedDurationsMinutes.includes(input.durationMinutes)) {
        throw new BadRequestException('Charging duration is not available for this connector');
      }

      const amount = Math.round(
        connector.pricingPlan.hourlyPriceVnd * (input.durationMinutes / 60),
      );
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new BadRequestException('Charging amount must be a positive whole VND amount');
      }

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
      const description = buildPaymentDescription(connector.code, input.durationMinutes);
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

  async handleWebhook(body: PayosWebhook): Promise<{ success: true }> {
    if (!this.payosClient.verifyWebhook(body.data, body.signature)) {
      throw new BadRequestException('Invalid PayOS webhook signature');
    }

    const orderCode = parsePositiveOrderCode(body.data.orderCode);
    const amount = parsePositiveAmount(body.data.amount);

    return this.dataSource.transaction(async (manager) => {
      const paymentRepository = manager.getRepository(PaymentTransaction);
      const orderRepository = manager.getRepository(Order);
      const sessionRepository = manager.getRepository(ChargingSession);
      const commandRepository = manager.getRepository(DeviceCommand);
      const payment = await paymentRepository.findOne({
        where: { order: { payosOrderCode: String(orderCode) } },
        relations: { order: { connector: { station: true } } },
        lock: { mode: 'pessimistic_write' },
      });

      if (!payment) {
        throw new NotFoundException('PayOS order not found');
      }
      if (payment.status === PaymentTransactionStatus.PAID) {
        return { success: true };
      }
      if (amount !== payment.order.amountVnd) {
        throw new BadRequestException('PayOS payment amount does not match the order');
      }

      payment.rawWebhookPayload = body as unknown as Record<string, unknown>;
      payment.signatureValid = true;
      payment.paymentLinkId =
        typeof body.data.paymentLinkId === 'string' ? body.data.paymentLinkId : payment.paymentLinkId;

      if (body.code !== '00' || body.success !== true) {
        const expired = body.data.status === 'EXPIRED';
        payment.status = expired
          ? PaymentTransactionStatus.EXPIRED
          : PaymentTransactionStatus.FAILED;
        payment.order.status = expired ? OrderStatus.EXPIRED : OrderStatus.PAYMENT_FAILED;
        await orderRepository.save(payment.order);
        await paymentRepository.save(payment);
        return { success: true };
      }

      payment.status = PaymentTransactionStatus.PAID;
      payment.order.status = OrderStatus.PAID;
      await orderRepository.save(payment.order);
      await paymentRepository.save(payment);

      const session = sessionRepository.create({
        id: randomUUID(),
        order: payment.order,
        connector: payment.order.connector,
        status: ChargingSessionStatus.PENDING,
        startedAt: null,
        expectedEndAt: new Date(Date.now() + payment.order.durationMinutes * 60_000),
        stoppedAt: null,
      });
      const savedSession = await sessionRepository.save(session);
      const command = commandRepository.create({
        id: randomUUID(),
        commandId: randomUUID(),
        session: savedSession,
        commandType: 'START_CHARGING',
        payload: {
          connectorCode: payment.order.connector.code,
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

function buildPaymentDescription(connectorCode: string, durationMinutes: number): string {
  const connector = connectorCode.replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
  const description = `Charge ${connector} ${durationMinutes / 60}h`;
  if (description.length > 25) {
    throw new BadRequestException('PayOS description exceeds 25 ASCII characters');
  }
  return description.padEnd(25, ' ');
}
