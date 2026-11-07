jest.mock('../../src/db.service', () => ({
  query: jest.fn(),
  read: jest.fn(),
  withTransaction: jest.fn(async (callback) => callback({ query: jest.fn() })),
}));
const db = require('../../src/db.service');
const disputes = require('../../src/modules/disputes.service');
const orders = require('../../src/modules/orders.service');
const listings = require('../../src/modules/listings.service');
const users = require('../../src/modules/users.service');
const reservations = require('../../src/modules/reservations.service');
const settlement = require('../../src/modules/settlement.service');
const eventBus = require('../../src/lib/eventBus');
const { NotYetSpecifiedError } = require('../../src/lib/errors');

describe('FR-68 Admin order dispute summary', () => {
  test('FR-68: returns dispute ids, status and time without evidence or reason text', async () => {
    db.read.mockResolvedValue({ rows: [
      { id: 'dispute-1', status: 'open', created_at: new Date('2026-11-06T12:00:00Z') },
      { id: 'dispute-2', status: 'resolved_release', created_at: new Date('2026-11-06T13:00:00Z') },
    ] });
    await expect(disputes.getAdminOrderDisputes('order-1')).resolves.toEqual({
      disputes: [
        { id: 'dispute-1', status: 'open', createdAt: new Date('2026-11-06T12:00:00Z') },
        { id: 'dispute-2', status: 'resolved_release', createdAt: new Date('2026-11-06T13:00:00Z') },
      ],
      hasOpenDispute: true,
    });
    expect(db.read.mock.calls[0][0]).not.toMatch(/reason_text|resolution_note|evidence/i);
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(orders, 'getMoneyLockContext').mockResolvedValue({
    listing_id: 'listing-1',
    buyer_id: 'buyer-1',
    reservation_id: 'reservation-1',
  });
  jest.spyOn(orders, 'lockReservationOrderForHandover').mockResolvedValue({
    id: 'order-1',
    listing_id: 'listing-1',
    buyer_id: 'buyer-1',
    reservation_id: 'reservation-1',
    status: 'held',
    delivered_at: new Date(),
  });
  jest.spyOn(listings, 'lockListingForMoneyAction').mockResolvedValue({ id: 'listing-1' });
  jest.spyOn(users, 'lockBuyerForMoneyAction').mockResolvedValue({ id: 'buyer-1' });
  jest.spyOn(reservations, 'lockReservationForSystemAction').mockResolvedValue({
    id: 'reservation-1',
    listing_id: 'listing-1',
    status: 'paid',
  });
  jest.spyOn(settlement, 'getSettingsForTransaction').mockResolvedValue({
    complaint_window_days: '3',
  });
});

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
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [dispute] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    db.withTransaction.mockImplementationOnce(async (callback) => callback(client));
    const emit = jest.spyOn(eventBus, 'emit').mockImplementation(() => true);
    try {
      await expect(disputes.fileDispute('order-1', 'buyer-1', {
        reasonText: 'The delivered item differs from the listing',
        evidenceUrls: ['https://example.test/evidence.jpg'],
      })).resolves.toEqual(dispute);
      expect(client.query).toHaveBeenCalledTimes(3);
      expect(client.query.mock.calls[1][0]).toContain("VALUES ($1, $2, $3, 'open')");
      expect(emit).toHaveBeenCalled();
    } finally {
      emit.mockRestore();
    }
  });

  test('FR-43: a second dispute for the same order returns a conflict without inserting another row', async () => {
    const client = {
      query: jest.fn().mockResolvedValueOnce({ rows: [{ id: 'existing-dispute' }] }),
    };
    db.withTransaction.mockImplementationOnce(async (callback) => callback(client));
    const emit = jest.spyOn(eventBus, 'emit').mockImplementation(() => true);
    try {
      await expect(disputes.fileDispute('order-1', 'buyer-1', {
        reasonText: 'The delivered item differs from the listing',
        evidenceUrls: ['https://example.test/evidence.jpg'],
      })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('already been filed') });
      expect(client.query).toHaveBeenCalledTimes(1);
      expect(emit).not.toHaveBeenCalled();
    } finally {
      emit.mockRestore();
    }
  });

  test('FR-65: a dispute cannot be filed after the order is completed by payout release', async () => {
    jest.spyOn(orders, 'lockReservationOrderForHandover').mockResolvedValue({
      id: 'order-1',
      listing_id: 'listing-1',
      buyer_id: 'buyer-1',
      reservation_id: 'reservation-1',
      status: 'completed',
      delivered_at: new Date(),
    });
    const client = { query: jest.fn().mockResolvedValueOnce({ rows: [] }) };
    db.withTransaction.mockImplementationOnce(async (callback) => callback(client));
    const emit = jest.spyOn(eventBus, 'emit').mockImplementation(() => true);
    try {
      await expect(disputes.fileDispute('order-1', 'buyer-1', {
        reasonText: 'The delivered item differs from the listing',
        evidenceUrls: ['https://example.test/evidence.jpg'],
      })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('already been released') });
      expect(client.query).toHaveBeenCalledTimes(1);
      expect(emit).not.toHaveBeenCalled();
    } finally {
      emit.mockRestore();
    }
  });
});

describe('FR-43, FR-45g dispute filing event transaction order', () => {
  const dispute = { id: 'dispute-1', order_id: 'order-1', status: 'open' };

  test('FR-45g: DISPUTE_FILED is emitted only after the transaction callback commits', async () => {
    const callOrder = [];
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [dispute] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    db.withTransaction.mockImplementationOnce(async (callback) => {
      callOrder.push('transaction-start');
      const result = await callback(client);
      callOrder.push('callback-complete');
      callOrder.push('transaction-commit');
      return result;
    });
    const emit = jest.spyOn(eventBus, 'emit').mockImplementation(() => {
      callOrder.push('event-emitted');
      return true;
    });

    try {
      await expect(disputes.fileDispute('order-1', 'buyer-1', {
        reasonText: 'The delivered item differs from the listing',
        evidenceUrls: ['https://example.test/evidence.jpg'],
      })).resolves.toEqual(dispute);
      expect(callOrder).toEqual([
        'transaction-start',
        'callback-complete',
        'transaction-commit',
        'event-emitted',
      ]);
    } finally {
      emit.mockRestore();
    }
  });

  test('FR-45g: DISPUTE_FILED is not emitted when the transaction callback throws', async () => {
    const transactionError = new Error('evidence insert failed');
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [dispute] })
        .mockRejectedValueOnce(transactionError),
    };
    db.withTransaction.mockImplementationOnce(async (callback) => callback(client));
    const emit = jest.spyOn(eventBus, 'emit').mockImplementation(() => true);

    try {
      await expect(disputes.fileDispute('order-1', 'buyer-1', {
        reasonText: 'The delivered item differs from the listing',
        evidenceUrls: ['https://example.test/evidence.jpg'],
      })).rejects.toBe(transactionError);
      expect(emit).not.toHaveBeenCalled();
    } finally {
      emit.mockRestore();
    }
  });
});
