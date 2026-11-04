const {
  PaymentGatewayConfigurationError,
  PaymentWebhookVerificationError,
  getPaymentGateway,
} = require('../../src/lib/adapters/paymentGateway');
const {
  buildSignedFakeEvent,
  createFakePaymentGateway,
} = require('../../src/lib/adapters/fakePaymentGateway');

const SECRET = 'unit-test-fake-webhook-secret-with-more-than-32-bytes';
let originalSecret;

beforeEach(() => {
  originalSecret = process.env.FAKE_GATEWAY_WEBHOOK_SECRET;
  process.env.FAKE_GATEWAY_WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.FAKE_GATEWAY_WEBHOOK_SECRET;
  else process.env.FAKE_GATEWAY_WEBHOOK_SECRET = originalSecret;
});

describe('PaymentGateway fake adapter contract', () => {
  test('idempotent hosted-checkout creation creates one deterministic fake session', async () => {
    const gateway = createFakePaymentGateway({ webhookSecret: SECRET });
    const request = {
      orderRef: 'order-1',
      amount: '1550.50',
      currency: 'PKR',
      idempotencyKey: 'pay:reservation-1:1',
      returnUrl: 'http://localhost:5173/?paymentReturn=order-1',
    };

    const first = await gateway.createHostedCheckout(request);
    const repeated = await gateway.createHostedCheckout(request);

    expect(repeated).toEqual(first);
    expect(gateway.getCreateCallCount()).toBe(2);
    expect(gateway.getSessionCount()).toBe(1);
    expect(first.providerPaymentRef).toMatch(/^fake_[a-f0-9]{32}$/);
    expect(first.checkoutUrl).toContain(`/fake-gateway/checkout/${first.providerPaymentRef}`);
  });

  test('fake webhook verifies valid signed raw bytes and returns a normalized event', async () => {
    const now = new Date('2026-11-01T12:00:00.000Z');
    const gateway = createFakePaymentGateway({ webhookSecret: SECRET });
    const signed = buildSignedFakeEvent({
      type: 'payment.succeeded',
      providerPaymentRef: 'fake_123',
      amount: '1550.50',
      currency: 'PKR',
      eventId: 'event-1',
      now,
    });

    await expect(gateway.verifyWebhook({ ...signed, now })).resolves.toMatchObject({
      provider: 'fake',
      type: 'payment.succeeded',
      eventId: 'event-1',
      providerPaymentRef: 'fake_123',
      amount: '1550.50',
      currency: 'PKR',
    });
  });

  test('fake webhook rejects a tampered body and a wrong secret', async () => {
    const now = new Date('2026-11-01T12:00:00.000Z');
    const gateway = createFakePaymentGateway({ webhookSecret: SECRET });
    const signed = buildSignedFakeEvent({
      type: 'payment.failed',
      providerPaymentRef: 'fake_123',
      amount: '10.00',
      currency: 'PKR',
      eventId: 'event-2',
      now,
    });
    const tampered = { ...signed, rawBody: Buffer.from(`${signed.rawBody.toString()} `) };
    await expect(gateway.verifyWebhook({ ...tampered, now }))
      .rejects.toBeInstanceOf(PaymentWebhookVerificationError);

    const wrongSecretGateway = createFakePaymentGateway({
      webhookSecret: 'different-unit-test-secret-with-at-least-32-bytes',
    });
    await expect(wrongSecretGateway.verifyWebhook({ ...signed, now }))
      .rejects.toBeInstanceOf(PaymentWebhookVerificationError);
  });

  test('fake webhook rejects missing and stale timestamps', async () => {
    const now = new Date('2026-11-01T12:00:00.000Z');
    const gateway = createFakePaymentGateway({ webhookSecret: SECRET });
    const signed = buildSignedFakeEvent({
      type: 'payment.succeeded',
      providerPaymentRef: 'fake_123',
      amount: '10.00',
      currency: 'PKR',
      eventId: 'event-3',
      now,
    });

    await expect(gateway.verifyWebhook({
      rawBody: signed.rawBody,
      headers: { 'x-fake-signature': signed.headers['x-fake-signature'] },
      now,
    })).rejects.toMatchObject({ code: 'invalid_signature' });
    await expect(gateway.verifyWebhook({
      ...signed,
      now: new Date('2026-11-01T12:06:00.000Z'),
    })).rejects.toMatchObject({ code: 'stale_timestamp' });
  });

  test('fake webhook verifies the signature before attempting JSON parsing', async () => {
    const gateway = createFakePaymentGateway({ webhookSecret: SECRET });
    await expect(gateway.verifyWebhook({
      rawBody: Buffer.from('{not-json'),
      headers: {
        'x-fake-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-fake-signature': '0'.repeat(64),
      },
    })).rejects.toMatchObject({ code: 'invalid_signature' });
  });

  test('FR-70: fake fetchPayment reports the stored pending, succeeded, and failed outcome', async () => {
    const gateway = createFakePaymentGateway({ webhookSecret: SECRET });
    const { providerPaymentRef } = await gateway.createHostedCheckout({
      orderRef: 'order-reconcile',
      amount: '250.00',
      currency: 'PKR',
      idempotencyKey: 'pay:reservation-reconcile:1',
      returnUrl: 'http://localhost:5173/',
    });

    await expect(gateway.fetchPayment({ providerPaymentRef })).resolves.toMatchObject({ status: 'pending' });
    gateway.setPaymentOutcome({ providerPaymentRef, status: 'succeeded' });
    await expect(gateway.fetchPayment({ providerPaymentRef })).resolves.toMatchObject({ status: 'succeeded' });
    gateway.setPaymentOutcome({ providerPaymentRef, status: 'failed' });
    await expect(gateway.fetchPayment({ providerPaymentRef })).resolves.toMatchObject({ status: 'failed' });
  });

  test('FR-69: fake refund adapter reuses one result per idempotency key', async () => {
    const gateway = createFakePaymentGateway({ webhookSecret: SECRET });
    const create = {
      orderRef: 'order-2',
      amount: '250.00',
      currency: 'PKR',
      idempotencyKey: 'pay:reservation-2:1',
      returnUrl: 'http://localhost:5173/',
    };
    const { providerPaymentRef } = await gateway.createHostedCheckout(create);

    await expect(gateway.fetchPayment({ providerPaymentRef })).resolves.toEqual({
      providerPaymentRef,
      status: 'pending',
      amount: '250.00',
      currency: 'PKR',
    });
    const firstRefund = await gateway.createRefund({
      providerPaymentRef,
      amount: '250.00',
      idempotencyKey: 'refund:payment-1',
    });
    const secondRefund = await gateway.createRefund({
      providerPaymentRef,
      amount: '250.00',
      idempotencyKey: 'refund:payment-1',
    });
    expect(secondRefund).toEqual(firstRefund);
    expect(gateway.getRefundCount()).toBe(1);
    expect(gateway.getRefund('refund:payment-1')).toEqual(firstRefund);
  });

  test('production refuses fake selection with a typed configuration error', () => {
    expect(() => getPaymentGateway({
      NODE_ENV: 'production',
      PAYMENT_GATEWAY_PROVIDER: 'fake',
      FAKE_GATEWAY_WEBHOOK_SECRET: SECRET,
    })).toThrow(PaymentGatewayConfigurationError);
  });
});
