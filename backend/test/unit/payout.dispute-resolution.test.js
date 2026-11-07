jest.mock('../../src/db.service', () => ({
  query: jest.fn(),
}));
jest.mock('../../src/modules/orders.service', () => ({
  getMoneyLockContext: jest.fn(),
}));
jest.mock('../../src/modules/escrowPayments.service', () => ({
  recordDisputeResolutionAuditEvent: jest.fn(),
}));

const orders = require('../../src/modules/orders.service');
const escrowPayments = require('../../src/modules/escrowPayments.service');
const payout = require('../../src/modules/payout.service');
const eventBus = require('../../src/lib/eventBus');
const events = require('../../src/lib/events');

describe('FR-45 reservation payout hold dispute-resolution listener', () => {
  const payload = {
    disputeId: 'dispute-1',
    orderId: 'order-1',
    resolutionStatus: 'resolved_release',
  };
  const resolvedBy = 'admin-1';
  let transaction;

  beforeEach(() => {
    jest.clearAllMocks();
    transaction = { query: jest.fn() };
    orders.getMoneyLockContext.mockResolvedValue({
      listing_id: 'listing-1',
      buyer_id: 'buyer-1',
      reservation_id: 'reservation-1',
    });
    escrowPayments.recordDisputeResolutionAuditEvent.mockResolvedValue(true);
    jest.spyOn(eventBus, 'emitAsync').mockResolvedValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('FR-45: seller resolution resumes a paused hold and retains its dispute id', async () => {
    transaction.query
      .mockResolvedValueOnce({ rows: [{ state: 'paused_for_dispute' }] })
      .mockResolvedValueOnce({ rows: [{ order_id: payload.orderId }] });

    await payout.handleDisputeResolved(payload, { transaction, resolvedBy });

    expect(transaction.query.mock.calls[0][0]).toMatch(/FOR UPDATE/i);
    expect(transaction.query.mock.calls[1][0]).toMatch(/SET state = 'held'/);
    expect(escrowPayments.recordDisputeResolutionAuditEvent).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({
        disputeId: payload.disputeId,
        adminId: resolvedBy,
        resolutionStatus: 'resolved_release',
      })
    );
    expect(eventBus.emitAsync).not.toHaveBeenCalled();
  });

  test('FR-45: buyer resolution records one audit and requests one manual exception in the same transaction', async () => {
    transaction.query.mockResolvedValueOnce({ rows: [{ state: 'paused_for_dispute' }] });
    escrowPayments.recordDisputeResolutionAuditEvent.mockResolvedValueOnce(true);

    await payout.handleDisputeResolved(
      { ...payload, resolutionStatus: 'resolved_refund' },
      { transaction, resolvedBy }
    );

    expect(transaction.query).toHaveBeenCalledTimes(1);
    expect(escrowPayments.recordDisputeResolutionAuditEvent).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ adminId: resolvedBy, resolutionStatus: 'resolved_refund' })
    );
    expect(eventBus.emitAsync).toHaveBeenCalledWith(
      events.DISPUTE_REFUND_EXCEPTION_REQUIRED,
      { orderId: payload.orderId, disputeId: payload.disputeId, resolvedBy },
      { transaction }
    );
  });

  test('FR-45: repeated buyer-resolution events do not request another exception or audit', async () => {
    transaction.query
      .mockResolvedValueOnce({ rows: [{ state: 'paused_for_dispute' }] })
      .mockResolvedValueOnce({ rows: [{ state: 'paused_for_dispute' }] });
    escrowPayments.recordDisputeResolutionAuditEvent
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const refundPayload = { ...payload, resolutionStatus: 'resolved_refund' };
    await payout.handleDisputeResolved(refundPayload, { transaction, resolvedBy });
    await payout.handleDisputeResolved(refundPayload, { transaction, resolvedBy });

    expect(eventBus.emitAsync).toHaveBeenCalledTimes(1);
    expect(escrowPayments.recordDisputeResolutionAuditEvent).toHaveBeenCalledTimes(2);
  });

  test('FR-45: a non-paused hold or legacy order has no resolution side effects', async () => {
    transaction.query.mockResolvedValueOnce({ rows: [{ state: 'released' }] });
    await payout.handleDisputeResolved(payload, { transaction, resolvedBy });
    expect(escrowPayments.recordDisputeResolutionAuditEvent).not.toHaveBeenCalled();
    expect(eventBus.emitAsync).not.toHaveBeenCalled();

    orders.getMoneyLockContext.mockResolvedValueOnce({ reservation_id: null });
    await payout.handleDisputeResolved(payload, { transaction, resolvedBy });
    expect(transaction.query).toHaveBeenCalledTimes(1);
    expect(escrowPayments.recordDisputeResolutionAuditEvent).not.toHaveBeenCalled();
  });

  test('FR-45: a missing transaction is surfaced as an error', async () => {
    await expect(payout.handleDisputeResolved(payload)).rejects.toThrow(
      'Dispute resolution payout effects require the resolution transaction.'
    );
  });
});
