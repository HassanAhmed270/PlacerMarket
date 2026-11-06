jest.mock('../../src/db.service', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(async (callback) => callback({ query: jest.fn() })),
}));
const db = require('../../src/db.service');
const disputes = require('../../src/modules/disputes.service');
const eventBus = require('../../src/lib/eventBus');
const { NotYetSpecifiedError } = require('../../src/lib/errors');

beforeEach(() => jest.clearAllMocks());

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
    db.withTransaction.mockImplementationOnce(async (callback) => callback({ query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: disputeId, status: 'resolved_refund' }] }) }));

    await expect(
      disputes.resolveDispute(disputeId, { resolutionAmountToBuyer: agreedItemPrice, resolvedBy: 'admin-1' })
    ).resolves.toBeDefined();
  });

  test('full release to seller (amount = 0) is allowed', async () => {
    mockDisputeLookup();
    db.withTransaction.mockImplementationOnce(async (callback) => callback({ query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: disputeId, status: 'resolved_release' }] }) }));

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

describe('FR-43 delivered reservation-order compatibility', () => {
  test('FR-43: fileDispute accepts a delivered reservation-backed order based on delivered_at', async () => {
    const dispute = { id: 'dispute-1', order_id: 'order-1', status: 'open' };
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [dispute] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    db.query.mockResolvedValueOnce({
      rows: [{
        reservation_id: 'reservation-1',
        buyer_id: 'buyer-1',
        status: 'held',
        delivered_at: new Date(),
      }],
    }).mockResolvedValueOnce({ rows: [{ value: '3' }] });
    db.withTransaction.mockImplementationOnce(async (callback) => callback(client));
    const emit = jest.spyOn(eventBus, 'emit').mockImplementation(() => true);
    try {
      await expect(disputes.fileDispute('order-1', 'buyer-1', {
        reasonText: 'The delivered item differs from the listing',
        evidenceUrls: ['https://example.test/evidence.jpg'],
      })).resolves.toEqual(dispute);
      expect(client.query).toHaveBeenCalledTimes(2);
      expect(client.query.mock.calls[0][0]).toContain("VALUES ($1, $2, $3, 'open')");
      expect(emit).toHaveBeenCalled();
    } finally {
      emit.mockRestore();
    }
  });
});
