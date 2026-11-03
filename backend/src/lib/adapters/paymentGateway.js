/**
 * PaymentGateway contract:
 * - createHostedCheckout({ orderRef, amount, currency, idempotencyKey, returnUrl })
 *   resolves to { providerPaymentRef, checkoutUrl, expiresAt? }.
 * - verifyWebhook({ rawBody, headers, now }) resolves to a normalized event or
 *   rejects with PaymentWebhookVerificationError.
 * - fetchPayment({ providerPaymentRef }) resolves to normalized provider state.
 * - createRefund({ providerPaymentRef, amount, idempotencyKey }) resolves to
 *   { providerRefundRef, providerPaymentRef, amount, status: 'succeeded' }.
 *
 * Implementations must be idempotent for a repeated idempotencyKey. Only the
 * non-production fake implementation is available in this stage.
 */

class PaymentGatewayConfigurationError extends Error {
  constructor() {
    super('Payment provider is not configured.');
    this.name = 'PaymentGatewayConfigurationError';
    this.statusCode = 503;
    this.code = 'payment_provider_not_configured';
  }
}

class PaymentGatewayUnavailableError extends Error {
  constructor(cause) {
    super('Payment gateway is temporarily unavailable.');
    this.name = 'PaymentGatewayUnavailableError';
    this.statusCode = 503;
    this.code = 'payment_gateway_unavailable';
    this.retryHint = 'retry_same_payment';
    if (cause) this.cause = cause;
  }
}

class PaymentWebhookVerificationError extends Error {
  constructor(code = 'invalid_webhook') {
    super('Fake payment webhook verification failed.');
    this.name = 'PaymentWebhookVerificationError';
    this.code = code;
    this.statusCode = 401;
  }
}

function getPaymentWebhookUrl(env = process.env) {
  const port = env.PORT || '3000';
  const value = env.PAYMENT_WEBHOOK_URL || `http://localhost:${port}/api/webhooks/payments/fake`;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('invalid URL');
    return url.href;
  } catch {
    throw new PaymentGatewayConfigurationError();
  }
}

function buildPaymentReturnUrl(orderId, env = process.env) {
  try {
    const base = new URL(env.PUBLIC_BASE_URL);
    if (!['http:', 'https:'].includes(base.protocol) || !base.hostname) throw new Error('invalid URL');
    const returnUrl = new URL('/', base);
    returnUrl.searchParams.set('paymentReturn', orderId);
    return returnUrl.href;
  } catch {
    throw new PaymentGatewayConfigurationError();
  }
}

let cachedFakeGateway;
let cachedFakeConfiguration;

function getPaymentGateway(env = process.env) {
  if (env.NODE_ENV === 'production' || env.PAYMENT_GATEWAY_PROVIDER !== 'fake') {
    throw new PaymentGatewayConfigurationError();
  }

  const webhookSecret = env.FAKE_GATEWAY_WEBHOOK_SECRET;
  if (typeof webhookSecret !== 'string' || Buffer.byteLength(webhookSecret, 'utf8') < 32) {
    throw new PaymentGatewayConfigurationError();
  }
  const configuration = [
    webhookSecret,
    getPaymentWebhookUrl(env),
    env.FAKE_GATEWAY_WEBHOOK_TOLERANCE_SECONDS || '300',
  ].join('\0');
  if (!cachedFakeGateway || cachedFakeConfiguration !== configuration) {
    const { createFakePaymentGateway } = require('./fakePaymentGateway');
    cachedFakeGateway = createFakePaymentGateway({
      webhookSecret,
      webhookUrl: getPaymentWebhookUrl(env),
      timestampToleranceSeconds: Number(env.FAKE_GATEWAY_WEBHOOK_TOLERANCE_SECONDS || 300),
    });
    cachedFakeConfiguration = configuration;
  }
  return cachedFakeGateway;
}

module.exports = {
  PaymentGatewayConfigurationError,
  PaymentGatewayUnavailableError,
  PaymentWebhookVerificationError,
  buildPaymentReturnUrl,
  getPaymentGateway,
  getPaymentWebhookUrl,
};
