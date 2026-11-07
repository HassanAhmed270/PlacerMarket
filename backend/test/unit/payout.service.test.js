jest.mock('../../src/db.service', () => ({
  read: jest.fn(),
  query: jest.fn(),
  withTransaction: jest.fn(),
}));
jest.mock('../../src/modules/settlement.service', () => ({
  getSettingsForTransaction: jest.fn(),
}));

const db = require('../../src/db.service');
const settlement = require('../../src/modules/settlement.service');
const payout = require('../../src/modules/payout.service');

describe('FR-68 Admin order payout hold summary', () => {
  test('FR-68: computes earliest release with database timestamp arithmetic and returns safe hold fields', async () => {
    const hold = {
      state: 'held',
      hold_started_at: new Date('2026-11-01T12:00:00Z'),
      hold_window_days: 5,
      complaint_window_days: 3,
      released_at: null,
      earliest_release_at: new Date('2026-11-06T12:00:00Z'),
    };
    db.read.mockResolvedValue({ rows: [hold] });
    await expect(payout.getAdminOrderHoldSnapshot('order-1', new Date('2026-11-02T12:00:00Z')))
      .resolves.toEqual({
        state: 'held',
        holdStartedAt: hold.hold_started_at,
        holdWindowDays: 5,
        complaintWindowDays: 3,
        earliestReleaseAt: hold.earliest_release_at,
        releasedAt: null,
      });
    expect(db.read.mock.calls[0][0]).toContain('GREATEST(');
  });
});

describe('reservation-backed payout holds', () => {
  beforeEach(() => jest.clearAllMocks());

  test('FR-45b, FR-45c: transaction-aware hold uses configured windows and reports insertion', async () => {
    settlement.getSettingsForTransaction.mockResolvedValue({
      payout_hold_days: '5',
      complaint_window_days: '3',
    });
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [{ order_id: 'order-1' }] }),
    };

    await expect(payout.startHoldForReservationOrder(client, 'order-1')).resolves.toBe(true);
    expect(settlement.getSettingsForTransaction).toHaveBeenCalledWith(client, [
      'payout_hold_days',
      'complaint_window_days',
    ]);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("VALUES ($1, now(), $2, $3, 'held')"),
      ['order-1', 5, 3]
    );
    expect(client.query.mock.calls[0][0]).toContain('ON CONFLICT (order_id) DO NOTHING');
  });

  test('FR-45b: a duplicate hold is reported without inserting a second row', async () => {
    settlement.getSettingsForTransaction.mockResolvedValue({
      payout_hold_days: '5',
      complaint_window_days: '3',
    });
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await expect(payout.startHoldForReservationOrder(client, 'order-1')).resolves.toBe(false);
  });

  test('FR-45c: invalid configured windows fail closed before inserting a hold', async () => {
    settlement.getSettingsForTransaction.mockResolvedValue({
      payout_hold_days: 'not-a-number',
      complaint_window_days: '3',
    });
    const client = { query: jest.fn() };
    await expect(payout.startHoldForReservationOrder(client, 'order-1'))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(client.query).not.toHaveBeenCalled();
  });
});
