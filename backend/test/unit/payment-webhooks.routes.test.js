const express = require('express');
const request = require('supertest');
const queue = require('../../src/lib/queue');
const { createFakePaymentGateway, buildSignedFakeEvent } = require('../../src/lib/adapters/fakePaymentGateway');
const { createPaymentWebhooksRouter } = require('../../src/routes/paymentWebhooks.routes');

const SECRET = 'unit-payment-webhook-secret-with-more-than-32-bytes';

describe('SEC-33 payment webhook durability failures', () => {
  let originalEnvironment;

  beforeEach(() => {
    originalEnvironment = {
      NODE_ENV: process.env.NODE_ENV,
      PAYMENT_GATEWAY_PROVIDER: process.env.PAYMENT_GATEWAY_PROVIDER,
      FAKE_GATEWAY_WEBHOOK_SECRET: process.env.FAKE_GATEWAY_WEBHOOK_SECRET,
    };
    process.env.NODE_ENV = 'test';
    process.env.PAYMENT_GATEWAY_PROVIDER = 'fake';
    process.env.FAKE_GATEWAY_WEBHOOK_SECRET = SECRET;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('SEC-33: an inbox insert failure returns 503 without enqueueing a job', async () => {
    const enqueueJob = jest.fn();
    const receiver = queue.createPaymentWebhookInboxReceiver({
      withTransaction: (callback) => callback({
        query: async (sql) => {
          if (sql.includes('INSERT INTO webhook_inbox')) {
            throw new Error('private database detail');
          }
          return { rows: [] };
        },
      }),
      enqueueJob,
      resolvePaymentId: async () => null,
    });
    const now = new Date();
    const signed = buildSignedFakeEvent({
      type: 'payment.succeeded',
      providerPaymentRef: 'fake_payment_test',
      amount: '10.00',
      currency: 'PKR',
      eventId: 'insert-failure-event',
      now,
    });
    const app = express();
    app.use('/api/webhooks/payments', createPaymentWebhooksRouter({
      receiver,
      gatewayResolver: () => createFakePaymentGateway({ webhookSecret: SECRET }),
      now: () => now,
    }));
    app.use(express.json());

    const response = await request(app)
      .post('/api/webhooks/payments/fake')
      .set('Content-Type', 'application/json')
      .set(signed.headers)
      .send(signed.rawBody.toString('utf8'))
      .expect(503);

    expect(response.body.error).not.toContain('private database detail');
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});
