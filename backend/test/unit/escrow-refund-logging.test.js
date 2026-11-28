jest.mock('../../src/db.service', () => ({
  read: jest.fn(),
  withTransaction: jest.fn(),
}));
jest.mock('../../src/modules/orders.service', () => ({
  getMoneyLockContext: jest.fn(),
  lockOrderForRefund: jest.fn(),
}));
jest.mock('../../src/modules/reservations.service', () => ({
  lockReservationForPayout: jest.fn(),
}));
jest.mock('../../src/modules/listings.service', () => ({
  lockListingForMoneyAction: jest.fn(),
  setSystemTakedownHandler: jest.fn(),
}));
jest.mock('../../src/modules/users.service', () => ({
  lockBuyerForMoneyAction: jest.fn(),
}));
jest.mock('../../src/modules/moneyAudit.service', () => ({
  recordMoneyAuditEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/lib/adapters/paymentGateway', () => {
  class PaymentGatewayConfigurationError extends Error {}
  class PaymentGatewayUnavailableError extends Error {
    constructor() {
      super('Payment gateway unavailable.');
      this.statusCode = 503;
    }
  }
  return {
    PaymentGatewayConfigurationError,
    PaymentGatewayUnavailableError,
    buildPaymentReturnUrl: jest.fn(),
    getPaymentGateway: jest.fn(),
  };
});

const db = require('../../src/db.service');
const orders = require('../../src/modules/orders.service');
const reservations = require('../../src/modules/reservations.service');
const listings = require('../../src/modules/listings.service');
const users = require('../../src/modules/users.service');
const moneyAudit = require('../../src/modules/moneyAudit.service');
const paymentGateway = require('../../src/lib/adapters/paymentGateway');
const escrowPayments = require('../../src/modules/escrowPayments.service');

describe('FR-79g: refund alert production logging', () => {
  test('SEC-27: refund failure alert emits a safe JSON line with UTC time', async () => {
    const previous = {
      nodeEnv: process.env.NODE_ENV,
      logLevel: process.env.LOG_LEVEL,
    };
    process.env.NODE_ENV = 'production';
    process.env.LOG_LEVEL = 'info';
    const stderr = jest.spyOn(console, 'error').mockImplementation(() => {});
    const refundId = '123e4567-e89b-42d3-a456-426614174000';
    const payment = {
      id: 'payment-1',
      order_id: 'order-1',
      provider_payment_id: 'provider-payment-1',
    };
    const refund = {
      id: refundId,
      order_id: 'order-1',
      payment_id: 'payment-1',
      status: 'pending',
      amount: '12.00',
      idempotency_key: 'refund-key',
      trigger: 'buyer_request',
      attempt_count: 5,
      needs_attention_at: null,
    };
    orders.getMoneyLockContext.mockResolvedValue({
      listing_id: 'listing-1',
      buyer_id: 'buyer-1',
      reservation_id: 'reservation-1',
    });
    listings.lockListingForMoneyAction.mockResolvedValue({ id: 'listing-1' });
    users.lockBuyerForMoneyAction.mockResolvedValue({ id: 'buyer-1' });
    orders.lockOrderForRefund.mockResolvedValue({
      id: 'order-1',
      listing_id: 'listing-1',
      buyer_id: 'buyer-1',
      reservation_id: 'reservation-1',
    });
    reservations.lockReservationForPayout.mockResolvedValue({
      id: 'reservation-1',
      listing_id: 'listing-1',
    });
    db.read.mockResolvedValue({ rows: [{ id: refundId, order_id: 'order-1', payment_id: 'payment-1' }] });
    db.withTransaction.mockImplementationOnce(async (callback) => {
      const client = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [payment] })
          .mockResolvedValueOnce({ rows: [refund] })
          .mockResolvedValueOnce({ rows: [] }),
      };
      return callback(client);
    }).mockImplementationOnce(async (callback) => {
      const client = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [payment] })
          .mockResolvedValueOnce({ rows: [refund] })
          .mockResolvedValueOnce({ rows: [{
            ...refund,
            status: 'failed',
            needs_attention_at: new Date('2026-02-02T00:00:00.000Z'),
          }] }),
      };
      return callback(client);
    });
    const gateway = {
      createRefund: jest.fn().mockRejectedValue(Object.assign(new Error('private provider details'), {
        code: 'gateway_unavailable',
      })),
    };
    paymentGateway.getPaymentGateway.mockReturnValue(gateway);

    try {
      await expect(escrowPayments.processRefundJob({ refundId })).rejects.toMatchObject({ statusCode: 503 });
      const entry = JSON.parse(stderr.mock.calls[0][0]);
      expect(entry).toMatchObject({
        level: 'error',
        msg: 'Refund alert',
        time: expect.stringMatching(/T.*Z$/),
        refundId,
        code: 'gateway_unavailable',
      });
      expect(JSON.stringify(entry)).not.toContain('private provider details');
      expect(moneyAudit.recordMoneyAuditEvent).toHaveBeenCalledTimes(1);
    } finally {
      stderr.mockRestore();
      jest.clearAllMocks();
      if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous.nodeEnv;
      if (previous.logLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previous.logLevel;
    }
  });
});
