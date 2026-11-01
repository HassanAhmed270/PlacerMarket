const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const { createConfiguredRateLimiters } = require('../middleware/rateLimit');
const escrowPayments = require('../modules/escrowPayments.service');
const {
  PaymentGatewayConfigurationError,
  PaymentGatewayUnavailableError,
} = require('../lib/adapters/paymentGateway');

const limiters = createConfiguredRateLimiters();

function paymentError(error, res, next) {
  if (error instanceof PaymentGatewayConfigurationError) {
    return res.status(503).json({
      error: 'Payment provider is not configured.',
      code: 'payment_provider_not_configured',
    });
  }
  if (error instanceof PaymentGatewayUnavailableError) {
    return res.status(503).json({
      error: 'Payment gateway is temporarily unavailable.',
      code: 'payment_gateway_unavailable',
      retryHint: error.retryHint,
    });
  }
  return next(error);
}

function createEscrowPaymentsRouter({
  service = escrowPayments,
  auth = requireAuth,
  limiter = limiters.security,
} = {}) {
  const router = Router();
  const noStore = (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    return next();
  };

  router.post('/:orderId/payment', noStore, (req, res, next) => {
    if (process.env.PAYMENTS_ENABLED !== '1') {
      return res.status(503).json({
        error: 'Payments are currently disabled.',
        code: 'payments_disabled',
      });
    }
    return next();
  }, auth, limiter, async (req, res, next) => {
    try {
      const result = await service.createOrReusePayment({
        orderId: req.params.orderId,
        buyerId: req.user.id,
      });
      return res.status(result.created ? 201 : 200).json({
        paymentId: result.paymentId,
        status: result.status,
        checkoutUrl: result.checkoutUrl,
        expiresAt: result.expiresAt,
        amount: result.amount,
        currency: result.currency,
      });
    } catch (error) {
      return paymentError(error, res, next);
    }
  });

  router.get('/:orderId/payment', noStore, auth, async (req, res, next) => {
    try {
      return res.json(await service.getPaymentStatus({
        orderId: req.params.orderId,
        buyerId: req.user.id,
      }));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = createEscrowPaymentsRouter();
module.exports.createEscrowPaymentsRouter = createEscrowPaymentsRouter;
