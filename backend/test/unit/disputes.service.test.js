jest.mock('../../src/db.service');
const db = require('../../src/db.service');
const disputes = require('../../src/modules/disputes.service');
const { NotYetSpecifiedError } = require('../../src/lib/errors');

// Template pattern: mock db.query per-test to return whatever the function
// under test needs, without a live Postgres connection. Extend this same
// pattern for other modules/*.service.js functions.

describe('disputes.service.resolveDispute — FR-45a guard', () => {
  const disputeId = 'dispute-1';
  const orderId = 'order-1';
  const agreedItemPrice = 5000;

  function mockDisputeLookup() {
    db.query.mockResolvedValueOnce({
      rows: [{ id: disputeId, order_id: orderId, agreed_item_price: agreedItemPrice }],
    });
  }

  test('full refund to buyer (amount = order total) is allowed', async () => {
    mockDisputeLookup();
    db.query.mockResolvedValueOnce({ rows: [{ id: disputeId, status: 'resolved_refund' }] }); // UPDATE result

    await expect(
      disputes.resolveDispute(disputeId, { resolutionAmountToBuyer: agreedItemPrice, resolvedBy: 'admin-1' })
    ).resolves.toBeDefined();
  });

  test('full release to seller (amount = 0) is allowed', async () => {
    mockDisputeLookup();
    db.query.mockResolvedValueOnce({ rows: [{ id: disputeId, status: 'resolved_release' }] }); // UPDATE result

    await expect(
      disputes.resolveDispute(disputeId, { resolutionAmountToBuyer: 0, resolvedBy: 'admin-1' })
    ).resolves.toBeDefined();
  });

  test('partial amount (neither 0 nor full) is refused with NotYetSpecifiedError(FR-45a)', async () => {
    mockDisputeLookup();

    await expect(
      disputes.resolveDispute(disputeId, { resolutionAmountToBuyer: 2500, resolvedBy: 'admin-1' })
    ).rejects.toThrow(NotYetSpecifiedError);
  });
});
