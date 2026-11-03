const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const {
  PaymentGatewayConfigurationError,
  PaymentGatewayUnavailableError,
  PaymentWebhookVerificationError,
} = require('./paymentGateway');

function nowMilliseconds(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  if (typeof now === 'string') return Date.parse(now);
  return Date.now();
}

function signatureFor(rawBody, secret) {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  const value = key ? headers[key] : undefined;
  return Array.isArray(value) ? value[0] : value;
}

function createFakePaymentGateway({
  webhookSecret = process.env.FAKE_GATEWAY_WEBHOOK_SECRET,
  webhookUrl,
  timestampToleranceSeconds = 300,
} = {}) {
  if (typeof webhookSecret !== 'string' || Buffer.byteLength(webhookSecret, 'utf8') < 32 ||
      !Number.isSafeInteger(timestampToleranceSeconds) || timestampToleranceSeconds <= 0) {
    throw new PaymentGatewayConfigurationError();
  }

  const sessionsByKey = new Map();
  const sessionsByRef = new Map();
  const refundsByKey = new Map();
  let createCalls = 0;
  let sessionsCreated = 0;

  return {
    provider: 'fake',

    async createHostedCheckout({ orderRef, amount, currency, idempotencyKey, returnUrl }) {
      createCalls += 1;
      const existing = sessionsByKey.get(idempotencyKey);
      if (existing) {
        return {
          providerPaymentRef: existing.providerPaymentRef,
          checkoutUrl: existing.checkoutUrl,
        };
      }

      const digest = createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32);
      const providerPaymentRef = `fake_${digest}`;
      const checkoutOrigin = webhookUrl ? new URL(webhookUrl).origin : `http://localhost:${process.env.PORT || 3000}`;
      const checkoutUrl = new URL(`/fake-gateway/checkout/${providerPaymentRef}`, checkoutOrigin).href;
      const session = {
        orderRef,
        amount: String(amount),
        currency,
        idempotencyKey,
        providerPaymentRef,
        checkoutUrl,
        returnUrl,
        status: 'pending',
      };
      sessionsByKey.set(idempotencyKey, session);
      sessionsByRef.set(providerPaymentRef, session);
      sessionsCreated += 1;
      return { providerPaymentRef, checkoutUrl };
    },

    async verifyWebhook({ rawBody, headers, now }) {
      if (!Buffer.isBuffer(rawBody) && !(rawBody instanceof Uint8Array)) {
        throw new PaymentWebhookVerificationError('invalid_body');
      }
      const timestamp = headerValue(headers, 'x-fake-timestamp');
      const suppliedSignature = headerValue(headers, 'x-fake-signature');
      if (typeof timestamp !== 'string' || !/^\d+$/.test(timestamp) ||
          typeof suppliedSignature !== 'string' || !/^[a-f0-9]{64}$/i.test(suppliedSignature)) {
        throw new PaymentWebhookVerificationError('invalid_signature');
      }

      const timestampSeconds = Number(timestamp);
      const currentSeconds = Math.floor(nowMilliseconds(now) / 1000);
      if (!Number.isSafeInteger(timestampSeconds) ||
          Math.abs(currentSeconds - timestampSeconds) > timestampToleranceSeconds) {
        throw new PaymentWebhookVerificationError('stale_timestamp');
      }

      const bodyBytes = Buffer.from(rawBody);
      const expectedSignature = Buffer.from(signatureFor(bodyBytes, webhookSecret), 'hex');
      const receivedSignature = Buffer.from(suppliedSignature, 'hex');
      if (expectedSignature.length !== receivedSignature.length ||
          !timingSafeEqual(expectedSignature, receivedSignature)) {
        throw new PaymentWebhookVerificationError('invalid_signature');
      }

      let event;
      try {
        event = JSON.parse(bodyBytes.toString('utf8'));
      } catch {
        throw new PaymentWebhookVerificationError('invalid_event');
      }
      if (!event || typeof event !== 'object' || Array.isArray(event) ||
          typeof event.type !== 'string' || !event.type ||
          typeof event.eventId !== 'string' || !event.eventId ||
          typeof event.providerPaymentRef !== 'string' || !event.providerPaymentRef ||
          typeof event.amount !== 'string' || !/^\d{1,10}\.\d{2}$/.test(event.amount) ||
          typeof event.currency !== 'string' || !event.currency) {
        throw new PaymentWebhookVerificationError('invalid_event');
      }
      return {
        provider: 'fake',
        eventId: event.eventId,
        type: event.type,
        providerPaymentRef: event.providerPaymentRef,
        amount: event.amount,
        currency: event.currency,
        occurredAt: new Date(timestampSeconds * 1000).toISOString(),
      };
    },

    async fetchPayment({ providerPaymentRef }) {
      const session = sessionsByRef.get(providerPaymentRef);
      if (!session) throw new PaymentGatewayUnavailableError();
      return {
        providerPaymentRef: session.providerPaymentRef,
        status: session.status,
        amount: session.amount,
        currency: session.currency,
      };
    },

    async createRefund({ providerPaymentRef, amount, idempotencyKey }) {
      const existingRefund = refundsByKey.get(idempotencyKey);
      if (existingRefund) return { ...existingRefund };

      const digest = createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32);
      const refund = {
        providerRefundRef: `fake_refund_${digest}`,
        providerPaymentRef,
        amount: String(amount),
        status: 'succeeded',
      };
      refundsByKey.set(idempotencyKey, refund);
      return { ...refund };
    },

    getCheckoutSession(providerPaymentRef) {
      return sessionsByRef.get(providerPaymentRef) || null;
    },

    getCreateCallCount() {
      return createCalls;
    },

    getSessionCount() {
      return sessionsCreated;
    },

    getRefundCount() {
      return refundsByKey.size;
    },

    getRefund(idempotencyKey) {
      const refund = refundsByKey.get(idempotencyKey);
      return refund ? { ...refund } : null;
    },
  };
}

function buildSignedFakeEvent({ type, providerPaymentRef, amount, currency, eventId, now }) {
  const webhookSecret = process.env.FAKE_GATEWAY_WEBHOOK_SECRET;
  if (typeof webhookSecret !== 'string' || Buffer.byteLength(webhookSecret, 'utf8') < 32) {
    throw new PaymentGatewayConfigurationError();
  }
  const timestamp = String(Math.floor(nowMilliseconds(now) / 1000));
  const rawBody = Buffer.from(JSON.stringify({
    type,
    providerPaymentRef,
    amount: String(amount),
    currency,
    eventId,
  }));
  return {
    rawBody,
    headers: {
      'x-fake-timestamp': timestamp,
      'x-fake-signature': signatureFor(rawBody, webhookSecret),
    },
  };
}

module.exports = { buildSignedFakeEvent, createFakePaymentGateway };
