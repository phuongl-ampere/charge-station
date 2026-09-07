import { BadRequestException } from '@nestjs/common';
import type { PayosWebhook, PayosWebhookData } from '@charge-station/contracts';

export function parsePayosWebhook(value: unknown): PayosWebhook {
  if (!isRecord(value)) {
    throw new BadRequestException('PayOS webhook body must be an object');
  }

  const { code, desc, success, data, signature } = value;
  if (typeof code !== 'string' || !code) {
    throw new BadRequestException(
      'PayOS webhook code must be a non-empty string',
    );
  }
  if (desc !== undefined && typeof desc !== 'string') {
    throw new BadRequestException('PayOS webhook desc must be a string');
  }
  if (typeof success !== 'boolean') {
    throw new BadRequestException('PayOS webhook success must be a boolean');
  }
  if (typeof signature !== 'string') {
    throw new BadRequestException('PayOS webhook signature must be a string');
  }
  if (!isRecord(data)) {
    throw new BadRequestException('PayOS webhook data must be an object');
  }
  if (
    typeof data.orderCode !== 'number' &&
    typeof data.orderCode !== 'string'
  ) {
    throw new BadRequestException(
      'PayOS webhook order code must be a number or string',
    );
  }
  if (typeof data.amount !== 'number' || !Number.isFinite(data.amount)) {
    throw new BadRequestException(
      'PayOS webhook amount must be a finite number',
    );
  }
  if (
    (data.paymentLinkId !== undefined &&
      typeof data.paymentLinkId !== 'string') ||
    (data.status !== undefined && typeof data.status !== 'string')
  ) {
    throw new BadRequestException(
      'PayOS webhook payment fields have invalid types',
    );
  }
  if (
    Object.values(data).some(
      (entry) =>
        entry !== null &&
        entry !== undefined &&
        typeof entry !== 'string' &&
        typeof entry !== 'number' &&
        typeof entry !== 'boolean',
    )
  ) {
    throw new BadRequestException(
      'PayOS webhook data must contain scalar values',
    );
  }

  return {
    code,
    ...(desc === undefined ? {} : { desc }),
    success,
    data: data as PayosWebhookData,
    signature,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
