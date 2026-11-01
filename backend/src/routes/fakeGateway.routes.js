const { Router, urlencoded } = require('express');
const db = require('../db.service');
const { buildSignedFakeEvent } = require('../lib/adapters/fakePaymentGateway');
const { buildPaymentReturnUrl, getPaymentWebhookUrl } = require('../lib/adapters/paymentGateway');

const SCENARIOS = Object.freeze({
  success: 'payment.succeeded',
  failure: 'payment.failed',
  duplicate: 'payment.succeeded',
  delayed: 'payment.succeeded',
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function renderPage({ providerPaymentRef, amount, currency, returnUrl, message }) {
  const ref = escapeHtml(providerPaymentRef);
  const escapedReturnUrl = escapeHtml(returnUrl);
  const notice = message ? `<p role="status">${escapeHtml(message)}</p>` : '';
  const actionRef = escapeHtml(encodeURIComponent(providerPaymentRef));
  const buttons = Object.keys(SCENARIOS).map((scenario) => (
    `<form method="post" action="/fake-gateway/checkout/${actionRef}/complete">` +
    `<input type="hidden" name="scenario" value="${scenario}">` +
    `<button type="submit">${scenario === 'success' ? 'Pay (success)' :
      scenario === 'failure' ? 'Fail' :
        scenario === 'duplicate' ? 'Duplicate' : 'Delayed'}</button></form>`
  )).join('');
  const refresh = message
    ? `<meta http-equiv="refresh" content="2;url=${escapedReturnUrl}">`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8">${refresh}<title>Fake checkout</title></head>` +
    `<body><main><h1>Fake checkout</h1><p>Amount: ${escapeHtml(amount)}</p>` +
    `<p>Currency: ${escapeHtml(currency)}</p><p>Reference: ${ref}</p>${notice}${buttons}` +
    `<a href="${escapedReturnUrl}">Return to marketplace</a></main></body></html>`;
}

function readDelayMs(value) {
  const delay = value === undefined ? 1000 : Number(value);
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > 30000) {
    throw new Error('FAKE_GATEWAY_DELAY_MS must be an integer from 0 to 30000.');
  }
  return delay;
}

function createFakeGatewayRouter({
  fetchImpl = globalThis.fetch,
  webhookUrl,
  delayMs = readDelayMs(process.env.FAKE_GATEWAY_DELAY_MS),
} = {}) {
  const router = Router();
  router.use(urlencoded({ extended: false, limit: '1kb' }));

  async function getPayment(providerPaymentRef) {
    const { rows } = await db.read(
      `SELECT provider_payment_id, amount, currency, order_id
       FROM payments
       WHERE provider = 'fake' AND provider_payment_id = $1`,
      [providerPaymentRef]
    );
    return rows[0] || null;
  }

  router.get('/checkout/:providerPaymentRef', async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const payment = await getPayment(req.params.providerPaymentRef);
      if (!payment) return res.status(404).type('text').send('Checkout not found.');
      const returnUrl = buildPaymentReturnUrl(payment.order_id);
      return res.type('html').send(renderPage({
        providerPaymentRef: payment.provider_payment_id,
        amount: payment.amount,
        currency: payment.currency,
        returnUrl,
      }));
    } catch (error) {
      return next(error);
    }
  });

  router.post('/checkout/:providerPaymentRef/complete', async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const eventType = SCENARIOS[req.body?.scenario];
      if (!eventType) return res.status(400).type('text').send('Invalid fake checkout scenario.');
      const payment = await getPayment(req.params.providerPaymentRef);
      if (!payment) return res.status(404).type('text').send('Checkout not found.');
      const returnUrl = buildPaymentReturnUrl(payment.order_id);
      if (req.body.scenario === 'delayed' && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      const signedEvent = buildSignedFakeEvent({
        type: eventType,
        providerPaymentRef: payment.provider_payment_id,
        amount: String(payment.amount),
        currency: payment.currency,
        eventId: `fake:${payment.provider_payment_id}:${req.body.scenario}`,
      });
      const target = webhookUrl || getPaymentWebhookUrl();
      const deliveries = req.body.scenario === 'duplicate' ? 2 : 1;
      const responses = [];
      try {
        for (let index = 0; index < deliveries; index += 1) {
          responses.push(await fetchImpl(target, {
            method: 'POST',
            headers: { ...signedEvent.headers, 'content-type': 'application/json' },
            body: signedEvent.rawBody,
          }));
        }
      } catch {
        return res.status(502).type('html').send('Webhook endpoint is unavailable.');
      }
      if (responses.some((response) => response.status === 404)) {
        return res.type('html').send(renderPage({
          providerPaymentRef: payment.provider_payment_id,
          amount: payment.amount,
          currency: payment.currency,
          returnUrl,
          message: 'webhook endpoint not available yet',
        }));
      }
      if (responses.some((response) => !response.ok)) {
        return res.status(502).type('html').send(renderPage({
          providerPaymentRef: payment.provider_payment_id,
          amount: payment.amount,
          currency: payment.currency,
          returnUrl,
          message: 'Webhook endpoint delivery failed.',
        }));
      }
      return res.redirect(303, returnUrl);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = createFakeGatewayRouter();
module.exports.createFakeGatewayRouter = createFakeGatewayRouter;
