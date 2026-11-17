jest.mock('../../src/db.service');
jest.mock('../../src/modules/moneyAudit.service');

const moneyAudit = require('../../src/modules/moneyAudit.service');
const sellerPayouts = require('../../src/modules/sellerPayouts.service');

describe('FR-69 dispute payout failure', () => {
  test('FR-69: fails initiated payouts and audits them in the supplied transaction', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ id: 'payout-1', attempt: 1 }] })
        .mockResolvedValueOnce({ rows: [{ id: 'payout-1' }] }),
    };

    await expect(sellerPayouts.failInitiatedPayoutForDispute(client, {
      orderId: 'order-1',
      disputeId: 'dispute-1',
      adminId: 'admin-1',
    })).resolves.toEqual(['payout-1']);

    expect(client.query.mock.calls[0][0]).toMatch(/status = 'initiated'[\s\S]*FOR UPDATE/i);
    expect(client.query.mock.calls[1][0]).toMatch(/failure_reason = 'dispute_decision'/);
    expect(client.query.mock.calls[1][0]).toMatch(/failed_by = \$1[\s\S]*failed_at = now\(\)/);
    expect(client.query.mock.calls[1][1]).toEqual(['admin-1', 'payout-1']);
    expect(moneyAudit.recordMoneyAuditEvent).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        actorId: 'admin-1',
        action: 'seller_payout_failed_by_dispute',
        orderId: 'order-1',
        reason: 'dispute_decision',
        metadata: { payoutId: 'payout-1', disputeId: 'dispute-1' },
      })
    );
  });
});
