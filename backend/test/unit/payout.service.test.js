jest.mock('../../src/modules/settlement.service', () => ({
  getSettingsForTransaction: jest.fn(),
}));

const settlement = require('../../src/modules/settlement.service');
const payout = require('../../src/modules/payout.service');

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
