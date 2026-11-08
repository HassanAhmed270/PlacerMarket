jest.mock('../../src/db.service', () => ({
  read: jest.fn(),
  query: jest.fn(),
  withTransaction: jest.fn(),
  withTransactionRetry: jest.fn(),
}));
jest.mock('../../src/modules/escrowPayments.service', () => ({
  isCapturedPaymentFullyRefunded: jest.fn(),
  lockPaymentAndRefundRowsForHandover: jest.fn(),
  recordOrderExceptionResolvedAuditEvent: jest.fn(),
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
}));
jest.mock('../../src/modules/users.service', () => ({
  lockBuyerForMoneyAction: jest.fn(),
}));
jest.mock('../../src/modules/payout.service', () => ({}));
jest.mock('../../src/modules/disputes.service', () => ({}));

const db = require('../../src/db.service');
const eventBus = require('../../src/lib/eventBus');
const events = require('../../src/lib/events');
const escrowPayments = require('../../src/modules/escrowPayments.service');
const orders = require('../../src/modules/orders.service');
const reservations = require('../../src/modules/reservations.service');
const listings = require('../../src/modules/listings.service');
const users = require('../../src/modules/users.service');
const delivery = require('../../src/modules/delivery.service');

const exceptionId = '11111111-1111-4111-8111-111111111111';
const adminId = '22222222-2222-4222-8222-222222222222';
const orderId = '33333333-3333-4333-8333-333333333333';
const client = { query: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  db.withTransaction.mockImplementation((callback) => callback(client));
});

describe('FR-68 Admin delivery metadata summary', () => {
  test('FR-68: returns only tracking number and safe exception fields', async () => {
    db.read.mockResolvedValue({ rows: [{
      tracking_note: 'Courier pickup confirmed\nTracking number: PK-123',
      exceptions: [{
        id: 'exception-1',
        kind: 'handover_after_cancel',
        recordedAt: '2026-11-06T12:00:00.000Z',
        resolvedAt: null,
      }],
    }] });
    await expect(delivery.getAdminOrderDeliveryMetadata(orderId)).resolves.toEqual({
      trackingNumber: 'PK-123',
      exceptions: [{
        id: 'exception-1',
        kind: 'handover_after_cancel',
        recordedAt: '2026-11-06T12:00:00.000Z',
        resolvedAt: null,
      }],
      hasUnresolvedException: true,
    });
    expect(db.read.mock.calls[0][0]).not.toMatch(/resolution_note|note AS|recorded_by/i);
  });
});

describe('delivery.service order exceptions — FR-72e', () => {
  test('FR-72e: list filters status and kind with a hard maximum limit of 100', async () => {
    db.query.mockResolvedValue({ rows: [] });

    await expect(delivery.listOrderExceptions({
      status: 'all',
      kind: 'handover_after_cancel',
      limit: '1000',
    })).resolves.toEqual([]);

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('kind = $1'),
      ['handover_after_cancel', 100]
    );
    expect(db.query.mock.calls[0][0]).toContain('ORDER BY recorded_at DESC, id DESC');
  });

  test('FR-72e: resolve locks the exception and writes its audit record in the same transaction', async () => {
    const updated = {
      id: exceptionId,
      orderId,
      kind: 'handover_after_cancel',
      resolvedBy: adminId,
      resolutionNote: 'Resolution confirmed',
    };
    client.query
      .mockResolvedValueOnce({
        rows: [{
          order_id: orderId,
          kind: 'handover_after_cancel',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: exceptionId,
          order_id: orderId,
          kind: 'handover_after_cancel',
          resolved_at: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [updated] });

    await expect(delivery.resolveOrderException(exceptionId, {
      resolvedBy: adminId,
      resolutionNote: '  Resolution confirmed  ',
    })).resolves.toEqual(updated);

    expect(db.withTransaction).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[1][0]).toContain('FOR UPDATE');
    expect(client.query.mock.calls[2][1]).toEqual([exceptionId, adminId, 'Resolution confirmed']);
    expect(escrowPayments.recordOrderExceptionResolvedAuditEvent).toHaveBeenCalledWith(client, {
      orderId,
      adminId,
      exceptionId,
      kind: 'handover_after_cancel',
      resolutionNote: 'Resolution confirmed',
    });
  });

  test('FR-69: dispute refund exception resolution requires the captured payment to be fully refunded', async () => {
    client.query.mockResolvedValueOnce({
      rows: [{ order_id: orderId, kind: 'dispute_refund_required' }],
    });
    orders.getMoneyLockContext.mockResolvedValue({
      listing_id: '44444444-4444-4444-8444-444444444444',
      buyer_id: '55555555-5555-4555-8555-555555555555',
      reservation_id: '66666666-6666-4666-8666-666666666666',
    });
    listings.lockListingForMoneyAction.mockResolvedValue({ id: 'listing-id' });
    users.lockBuyerForMoneyAction.mockResolvedValue({ id: 'buyer-id' });
    orders.lockOrderForRefund.mockResolvedValue({
      id: orderId,
      listing_id: '44444444-4444-4444-8444-444444444444',
      buyer_id: '55555555-5555-4555-8555-555555555555',
      reservation_id: '66666666-6666-4666-8666-666666666666',
    });
    reservations.lockReservationForPayout.mockResolvedValue({
      id: '66666666-6666-4666-8666-666666666666',
      listing_id: '44444444-4444-4444-8444-444444444444',
      status: 'paid',
    });
    escrowPayments.isCapturedPaymentFullyRefunded.mockResolvedValue(false);

    await expect(delivery.resolveOrderException(exceptionId, {
      resolvedBy: adminId,
      resolutionNote: 'Refund first, then close.',
    })).rejects.toMatchObject({
      statusCode: 409,
      message: 'Refund the buyer first; this exception closes automatically when the refund succeeds.',
    });

    expect(escrowPayments.isCapturedPaymentFullyRefunded).toHaveBeenCalledWith(client, orderId);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(escrowPayments.recordOrderExceptionResolvedAuditEvent).not.toHaveBeenCalled();
  });
});

describe('manual refund completion event — FR-69', () => {
  test('FR-69: listener requires the refund transaction', async () => {
    await expect(eventBus.emitAsync(events.MANUAL_REFUND_SUCCEEDED, {
      orderId,
      paymentId: '77777777-7777-4777-8777-777777777777',
      refundId: '88888888-8888-4888-8888-888888888888',
      approvedBy: adminId,
    })).rejects.toThrow(TypeError);
  });

  test('FR-69: listener is a no-op when no unresolved dispute refund exception exists', async () => {
    const transaction = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await expect(eventBus.emitAsync(events.MANUAL_REFUND_SUCCEEDED, {
      orderId,
      paymentId: '77777777-7777-4777-8777-777777777777',
      refundId: '88888888-8888-4888-8888-888888888888',
      approvedBy: adminId,
    }, { transaction })).resolves.toBe(true);

    expect(transaction.query).toHaveBeenCalledTimes(1);
    expect(transaction.query.mock.calls[0][0]).toContain("kind = 'dispute_refund_required'");
    expect(escrowPayments.recordOrderExceptionResolvedAuditEvent).not.toHaveBeenCalled();
  });
});
