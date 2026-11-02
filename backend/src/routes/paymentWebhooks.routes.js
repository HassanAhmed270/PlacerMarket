const express = require('express');
const { Router } = express;
const escrowPayments = require('../modules/escrowPayments.service');
const {
  PaymentGatewayConfigurationError,
  PaymentWebhookVerificationError,
  getPaymentGateway,
} = require('../lib/adapters/paymentGateway');

function createPaymentWebhooksRouter({
  receiver = escrowPayments.receiveVerifiedPaymentWebhook,
  gatewayResolver = getPaymentGateway,
  now = () => new Date(),
} = {}) {
  const router = Router();

  router.post('/:provider', express.raw({ type: '*/*', limit: '64kb' }), async (req, res, next) => {
    if (req.params.provider !== 'fake' ||
        process.env.NODE_ENV === 'production' ||
        process.env.PAYMENT_GATEWAY_PROVIDER !== 'fake') {
      return res.status(404).json({ error: 'Not found.' });
    }

    let gateway;
    try {
      gateway = gatewayResolver();
    } catch (error) {
      if (error instanceof PaymentGatewayConfigurationError) {
        return res.status(404).json({ error: 'Not found.' });
      }
      return next(error);
    }

    let event;
    try {
      event = await gateway.verifyWebhook({
        rawBody: req.body,
        headers: req.headers,
        now: now(),
      });
    } catch (error) {
      if (error instanceof PaymentWebhookVerificationError) {
        const status = error.code === 'invalid_event' ? 400 : 401;
        return res.status(status).json({
          error: status === 400 ? 'Invalid payment webhook event.' : 'Invalid payment webhook signature.',
        });
      }
      return next(error);
    }

    try {
      await receiver({
        provider: 'fake',
        event,
        rawBody: req.body,
        signatureMetadata: { header: 'x-fake-signature', algorithm: 'hmac-sha256' },
        timestampMetadata: {
          header: 'x-fake-timestamp',
          value: req.get('x-fake-timestamp'),
        },
        verifiedAt: now(),
      });
    } catch {
      return res.status(503).json({ error: 'Payment webhook receipt is temporarily unavailable.' });
    }

    return res.status(200).json({ received: true });
  });

  return router;
}

module.exports = createPaymentWebhooksRouter();
module.exports.createPaymentWebhooksRouter = createPaymentWebhooksRouter;
