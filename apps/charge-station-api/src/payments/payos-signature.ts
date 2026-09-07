import { createHmac, timingSafeEqual } from 'node:crypto';

type PayosData = Record<string, unknown>;

function serializePayosData(data: PayosData): string {
  return Object.entries(data)
    .filter(([, value]) => value !== '' && value !== null && value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('&');
}

export function buildPayosSignature(data: PayosData, checksumKey: string): string {
  return createHmac('sha256', checksumKey).update(serializePayosData(data)).digest('hex');
}

export function verifyPayosSignature(
  data: PayosData,
  signature: string,
  checksumKey: string,
): boolean {
  const expected = Buffer.from(buildPayosSignature(data, checksumKey), 'hex');
  const received = Buffer.from(signature, 'hex');

  return received.length === expected.length && timingSafeEqual(received, expected);
}
