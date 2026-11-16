jest.mock('../../src/db.service', () => ({
  query: jest.fn(),
}));
jest.mock('../../src/modules/orders.service', () => ({}));
jest.mock('../../src/modules/escrowPayments.service', () => ({}));

const payout = require('../../src/modules/payout.service');

describe('FR-69 durable dispute payout-hold release', () => {
  const payload = {
    disputeId: 'dispute-1',
    orderId: 'order-1',
    resolutionStatus: 'resolved_other',
  };
  let transaction;

  beforeEach(() => {
    transaction = { query: jest.fn() };
  });

  test('FR-69: every decided outcome clears the matching paused hold transactionally', async () => {
    transaction.query
      .mockResolvedValueOnce({
        rows: [{ state: 'paused_for_dispute', dispute_id: payload.disputeId }],
      })
      .mockResolvedValueOnce({ rowCount: 1 });

    await payout.handleDisputeResolved(payload, { transaction });

    expect(transaction.query.mock.calls[0][0]).toMatch(/FOR UPDATE/i);
    expect(transaction.query.mock.calls[1][0]).toMatch(/SET state = 'held'/);
    expect(transaction.query.mock.calls[1][0]).toMatch(/dispute_id = \$2/);
    expect(transaction.query.mock.calls[1][1]).toEqual([payload.orderId, payload.disputeId]);
  });

  test('FR-69: an absent, released, or mismatched hold is not changed', async () => {
    transaction.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ state: 'released', dispute_id: payload.disputeId }],
      })
      .mockResolvedValueOnce({
        rows: [{ state: 'paused_for_dispute', dispute_id: 'another-dispute' }],
      });

    await payout.handleDisputeResolved(payload, { transaction });
    await payout.handleDisputeResolved(payload, { transaction });
    await payout.handleDisputeResolved(payload, { transaction });
    expect(transaction.query).toHaveBeenCalledTimes(3);
  });

  test('FR-69: a missing transaction is surfaced as an error', async () => {
    await expect(payout.handleDisputeResolved(payload)).rejects.toThrow(
      'Dispute resolution payout effects require the resolution transaction.'
    );
  });

  test('FR-69: payout owner reports only a persisted paused dispute hold', async () => {
    transaction.query
      .mockResolvedValueOnce({ rows: [{ state: 'paused_for_dispute' }] })
      .mockResolvedValueOnce({ rows: [{ state: 'held' }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(payout.hasPausedDisputeHold(transaction, payload.orderId)).resolves.toBe(true);
    await expect(payout.hasPausedDisputeHold(transaction, payload.orderId)).resolves.toBe(false);
    await expect(payout.hasPausedDisputeHold(transaction, payload.orderId)).resolves.toBe(false);
  });
});
