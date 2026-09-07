import { describe, expect, it } from 'vitest';

import { PayosClient } from './payos.client.js';

describe('PayosClient mock provider', () => {
  it('creates a deterministic local checkout without a network request', async () => {
    const client = new PayosClient({
      mode: 'mock',
      clientId: 'client-id',
      apiKey: 'api-key',
      checksumKey: 'checksum-key',
      returnUrl: 'http://localhost:5173/charge/return',
      cancelUrl: 'http://localhost:5173/charge/cancel',
    });

    await expect(
      client.createPaymentLink({
        amount: 10000,
        orderCode: 100001,
        description: 'Charge ST01C01 2h        ',
        returnUrl: 'http://localhost:5173/charge/return',
        cancelUrl: 'http://localhost:5173/charge/cancel',
      }),
    ).resolves.toEqual({
      checkoutUrl: 'http://localhost:4000/payments/payos/mock/100001',
      paymentLinkId: 'mock_100001',
    });
  });

  it('signs a local webhook fixture that it can verify', () => {
    const client = new PayosClient({
      mode: 'mock',
      clientId: 'client-id',
      apiKey: 'api-key',
      checksumKey: 'checksum-key',
      returnUrl: 'http://localhost:5173/charge/return',
      cancelUrl: 'http://localhost:5173/charge/cancel',
    });
    const data = { amount: 10000, orderCode: 100001, paymentLinkId: 'mock_100001', status: 'PAID' };

    expect(client.verifyWebhook(data, client.signWebhook(data))).toBe(true);
  });
});
