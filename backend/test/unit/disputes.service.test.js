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
const escrowPayments = require('../../src/modules/escrowPayments.service');
const settlement = require('../../src/modules/settlement.service');
const moneyAudit = require('../../src/modules/moneyAudit.service');
const eventBus = require('../../src/lib/eventBus');
const { NotFoundError } = require('../../src/lib/errors');

describe('FR-43c dispute action predicates', () => {
  test('FR-43c: open, responded, decided, and withdrawn disputes expose shared seller and buyer actions', () => {
    expect(disputes.getDisputeActionPredicates({ status: 'open' })).toEqual({
      seller: { canCounter: true, canAddEvidence: true },
      buyer: { canWithdraw: true, canAddEvidence: true },
    });
    expect(disputes.getDisputeActionPredicates({
      status: 'seller_responded',
      sellerRespondedAt: '2026-11-20T10:00:00Z',
    })).toEqual({
      seller: { canCounter: false, canAddEvidence: true },
      buyer: { canWithdraw: false, canAddEvidence: true },
    });
    for (const status of ['resolved_refund', 'resolved_release', 'resolved_other', 'withdrawn']) {
      expect(disputes.getDisputeActionPredicates({ status })).toEqual({
        seller: { canCounter: false, canAddEvidence: false },
        buyer: { canWithdraw: false, canAddEvidence: false },
      });
    }
  });
});

function fileDispute(orderId, buyerId, input, dependencies = {}) {
  return disputes.fileDispute(orderId, buyerId, input, {
    getOrderPayoutStatus: jest.fn().mockResolvedValue(null),
    pausePayoutHold: jest.fn().mockResolvedValue(undefined),
    hasOpenReturnRequest: jest.fn().mockResolvedValue(false),
    ...dependencies,
  });
}

describe('FR-68 Admin order dispute summary', () => {
  test('FR-69: money audit owner reads the post-payout dispute marker', async () => {
    db.read.mockResolvedValue({ rows: [{ present: true }] });

    await expect(moneyAudit.hasDisputeAfterPayout('order-1')).resolves.toBe(true);
    expect(db.read.mock.calls[0][0]).toContain("action = 'dispute_after_payout'");
    expect(db.read.mock.calls[0][1]).toEqual(['order-1']);
  });

  test('FR-68: returns decision outcome and post-payout status without Admin identity or evidence', async () => {
    const decidedAt = new Date('2026-11-06T13:00:00Z');
    db.read.mockResolvedValue({ rows: [
      { id: 'dispute-1', status: 'open', created_at: new Date('2026-11-06T12:00:00Z') },
      {
        id: 'dispute-2',
        status: 'resolved_release',
        outcome: 'seller_favor',
        resolution_note: 'Reviewed evidence and released payout.',
        created_at: decidedAt,
        resolved_at: decidedAt,
      },
    ] });
    const afterPayoutSpy = jest.spyOn(moneyAudit, 'hasDisputeAfterPayout').mockResolvedValue(true);
    try {
      await expect(disputes.getAdminOrderDisputes('order-1')).resolves.toEqual({
        disputes: [
          {
            id: 'dispute-1',
            status: 'open',
            outcome: null,
            reason: null,
            decidedAt: null,
            createdAt: new Date('2026-11-06T12:00:00Z'),
            disputeAfterPayout: true,
            timeline: [],
          },
          {
            id: 'dispute-2',
            status: 'resolved_release',
            outcome: 'seller_favor',
            reason: 'Reviewed evidence and released payout.',
            decidedAt,
            createdAt: decidedAt,
            disputeAfterPayout: true,
            timeline: [],
          },
        ],
        hasOpenDispute: true,
      });
      expect(db.read.mock.calls[0][0]).not.toMatch(/reason_text|evidence|resolved_by/i);
      expect(afterPayoutSpy).toHaveBeenCalledWith('order-1');
    } finally {
      afterPayoutSpy.mockRestore();
    }
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
  jest.spyOn(orders, 'lockReservationOrderForPayout').mockResolvedValue({
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
  jest.spyOn(reservations, 'lockReservationForPayout').mockResolvedValue({
    id: 'reservation-1',
    listing_id: 'listing-1',
    status: 'paid',
  });
  jest.spyOn(escrowPayments, 'lockPaymentsForOrder').mockResolvedValue([]);
  jest.spyOn(settlement, 'getSettingsForTransaction').mockResolvedValue({
    complaint_window_days: '3',
  });
});

// Template pattern: mock db.query per-test to return whatever the function
// under test needs, without a live Postgres connection. Extend this same
// pattern for other modules/*.service.js functions.

describe('Dispute decision status and exact money inputs', () => {
  const disputeId = '00000000-0000-4000-8000-000000000001';
  const orderId = 'order-1';

  test('FR-69: a resolved buyer-favor dispute cannot be decided again', async () => {
    db.read.mockResolvedValue({ rows: [{ order_id: orderId }] });
    db.withTransaction.mockImplementationOnce(async (callback) => callback({ query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: disputeId, order_id: orderId, status: 'resolved_refund' }] }) }));

    await expect(
      disputes.resolveDispute(disputeId, {
        outcome: 'buyer_favor',
        amount: '5000.00',
        reason: 'Reviewed buyer evidence.',
        resolvedBy: 'admin-1',
        sessionId: 'session-1',
        stepUpGrant: 'grant-1',
      }, {
        failInitiatedPayoutForDispute: jest.fn().mockResolvedValue([]),
        hasOpenOtherPayoutIssue: jest.fn().mockResolvedValue(false),
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test('FR-69: a resolved seller-favor dispute cannot be decided again', async () => {
    db.read.mockResolvedValue({ rows: [{ order_id: orderId }] });
    db.withTransaction.mockImplementationOnce(async (callback) => callback({ query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: disputeId, order_id: orderId, status: 'resolved_release' }] }) }));

    await expect(
      disputes.resolveDispute(disputeId, {
        outcome: 'seller_favor',
        reason: 'Reviewed seller evidence.',
        resolvedBy: 'admin-1',
        sessionId: 'session-1',
        stepUpGrant: 'grant-1',
      }, {
        hasOpenOtherPayoutIssue: jest.fn().mockResolvedValue(false),
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test('FR-69: a missing dispute is reported as NotFoundError', async () => {
    db.read.mockResolvedValue({ rows: [] });

    await expect(
      disputes.resolveDispute(disputeId, {
        outcome: 'seller_favor',
        reason: 'Reviewed seller evidence.',
        resolvedBy: 'admin-1',
        sessionId: 'session-1',
        stepUpGrant: 'grant-1',
      })
    ).rejects.toThrow(new NotFoundError('dispute', disputeId));
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test('FR-69: dispute refund amounts must be decimal strings, not JavaScript numbers', async () => {

    await expect(
      disputes.resolveDispute(disputeId, {
        outcome: 'split',
        amount: 25,
        reason: 'Partially refund the buyer.',
        resolvedBy: 'admin-1',
        sessionId: 'session-1',
        stepUpGrant: 'grant-1',
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(db.withTransaction).not.toHaveBeenCalled();
  });
});

describe('FR-43 delivered reservation-order compatibility', () => {
  test('FR-43, FR-43a: Buyer eligibility includes the complaint window and server evidence limit', async () => {
    db.read.mockResolvedValue({ rows: [] });
    const setting = jest.spyOn(settlement, 'getSetting').mockResolvedValue('3');
    try {
      const state = await disputes.getBuyerDisputeFilingStatus({
        orderId: 'order-1',
        status: 'held',
        deliveredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });
      expect(state.canFileDispute).toBe(true);
      expect(state.disputeStatus).toBeNull();
      expect(state.maxEvidenceUrls).toBe(2);
      expect(state.complaintWindowClosesAt).toBeTruthy();
    } finally {
      setting.mockRestore();
    }
  });

  test('FR-43a: filing rejects more evidence URLs than the server limit', async () => {
    await expect(fileDispute('order-1', 'buyer-1', {
      reasonText: 'The delivered item differs from the listing',
      evidenceUrls: [
        'https://example.test/one',
        'https://example.test/two',
        'https://example.test/three',
      ],
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test('FR-43a: filing rejects non-HTTPS evidence URLs', async () => {
    await expect(fileDispute('order-1', 'buyer-1', {
      reasonText: 'The delivered item differs from the listing',
      evidenceUrls: ['javascript:alert(1)'],
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test('FR-43b: filing rejects a blank free-text reason', async () => {
    await expect(fileDispute('order-1', 'buyer-1', {
      reasonText: '  ',
      evidenceUrls: ['https://example.test/evidence'],
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test('FR-43: fileDispute accepts a delivered reservation-backed order based on delivered_at', async () => {
    const dispute = { id: 'dispute-1', order_id: 'order-1', status: 'open' };
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [dispute] }),
    };
    db.withTransaction.mockImplementationOnce(async (callback) => callback(client));
    const emit = jest.spyOn(eventBus, 'emit').mockImplementation(() => true);
    const pausePayoutHold = jest.fn().mockResolvedValue(undefined);
    try {
      await expect(fileDispute('order-1', 'buyer-1', {
        reasonText: 'The delivered item differs from the listing',
        evidenceUrls: ['https://example.test/evidence.jpg'],
      }, { pausePayoutHold })).resolves.toEqual(dispute);
      expect(client.query).toHaveBeenCalledTimes(2);
      expect(client.query.mock.calls[1][0]).toContain("VALUES ($1, $2, $3, 'open')");
      expect(pausePayoutHold).toHaveBeenCalledWith(client, expect.objectContaining({
        orderId: 'order-1',
        disputeId: dispute.id,
      }));
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
      await expect(fileDispute('order-1', 'buyer-1', {
        reasonText: 'The delivered item differs from the listing',
        evidenceUrls: ['https://example.test/evidence.jpg'],
      })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('already been filed') });
      expect(client.query).toHaveBeenCalledTimes(1);
      expect(emit).not.toHaveBeenCalled();
    } finally {
      emit.mockRestore();
    }
  });

  test('FR-69: a dispute after paid payout is audited without pausing the payout hold', async () => {
    jest.spyOn(orders, 'lockReservationOrderForHandover').mockResolvedValue({
      id: 'order-1',
      listing_id: 'listing-1',
      buyer_id: 'buyer-1',
      reservation_id: 'reservation-1',
      status: 'completed',
      delivered_at: new Date(),
    });
    const dispute = { id: 'dispute-1', order_id: 'order-1', status: 'open' };
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [dispute] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    db.withTransaction.mockImplementationOnce(async (callback) => callback(client));
    const emit = jest.spyOn(eventBus, 'emit').mockImplementation(() => true);
    const pausePayoutHold = jest.fn();
    const getOrderPayoutStatus = jest.fn().mockResolvedValue('paid');
    try {
      await expect(fileDispute('order-1', 'buyer-1', {
        reasonText: 'The delivered item differs from the listing',
        evidenceUrls: ['https://example.test/evidence.jpg'],
      }, { getOrderPayoutStatus, pausePayoutHold })).resolves.toEqual({
        ...dispute,
        dispute_after_payout: true,
      });
      expect(getOrderPayoutStatus).toHaveBeenCalledWith(client, 'order-1');
      expect(pausePayoutHold).not.toHaveBeenCalled();
      expect(emit).toHaveBeenCalled();
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
      await expect(fileDispute('order-1', 'buyer-1', {
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
    const transactionError = new Error('payout hold write failed');
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [dispute] }),
    };
    db.withTransaction.mockImplementationOnce(async (callback) => callback(client));
    const emit = jest.spyOn(eventBus, 'emit').mockImplementation(() => true);
    const pausePayoutHold = jest.fn().mockRejectedValue(transactionError);

    try {
      await expect(fileDispute('order-1', 'buyer-1', {
        reasonText: 'The delivered item differs from the listing',
        evidenceUrls: ['https://example.test/evidence.jpg'],
      }, { pausePayoutHold })).rejects.toBe(transactionError);
      expect(emit).not.toHaveBeenCalled();
    } finally {
      emit.mockRestore();
    }
  });
});

describe('FR-43c evidence and FR-43 withdrawal', () => {
  const disputeId = '00000000-0000-4000-8000-000000000001';

  test('FR-43c: evidence notes outside 3 to 500 characters are rejected before database writes', async () => {
    await expect(disputes.addDisputeEvidence(disputeId, 'buyer-1', { note: 'no' }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(disputes.addDisputeEvidence(disputeId, 'buyer-1', { note: 'x'.repeat(501) }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test('FR-43c: the party evidence projection omits contributor IDs', async () => {
    const parties = jest.spyOn(orders, 'getDeliveryOrderParties').mockResolvedValue({
      buyer_id: 'buyer-1',
      seller_id: 'seller-1',
    });
    db.read
      .mockResolvedValueOnce({ rows: [{ id: disputeId, order_id: 'order-1', raised_by: 'buyer-1' }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'evidence-1',
        uploaded_by: 'buyer-1',
        file_url: null,
        note: 'The item has a damaged seam.',
        created_at: new Date('2026-11-06T12:00:00Z'),
      }] });

    try {
      await expect(disputes.getPartyDisputeEvidence(disputeId, 'seller-1')).resolves.toEqual([{
        id: 'evidence-1',
        mediaReference: null,
        note: 'The item has a damaged seam.',
        createdAt: new Date('2026-11-06T12:00:00Z'),
        submittedBy: 'buyer',
      }]);
    } finally {
      parties.mockRestore();
    }
  });

  test('FR-43: withdrawal audits and clears the shared payout hold in the transaction', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{
          id: disputeId,
          order_id: 'order-1',
          raised_by: 'buyer-1',
          status: 'open',
          seller_responded_at: null,
        }] })
        .mockResolvedValueOnce({ rows: [{
          id: disputeId,
          order_id: 'order-1',
          status: 'withdrawn',
          withdrawn_at: new Date('2026-11-06T12:00:00Z'),
        }] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    db.read.mockResolvedValueOnce({ rows: [{ order_id: 'order-1' }] });
    db.withTransaction.mockImplementationOnce(async (callback) => callback(client));
    const clearPayoutHold = jest.fn().mockResolvedValue(true);

    await expect(disputes.withdrawDispute(disputeId, 'buyer-1', {
      clearPayoutHold,
      hasOpenOtherPayoutIssue: jest.fn().mockResolvedValue(false),
    })).resolves.toMatchObject({ status: 'withdrawn', orderId: 'order-1' });
    expect(client.query.mock.calls[2][1][1]).toBe('dispute_withdrawn');
    expect(clearPayoutHold).toHaveBeenCalledWith(client, 'order-1', { keepPaused: false });
  });
});
