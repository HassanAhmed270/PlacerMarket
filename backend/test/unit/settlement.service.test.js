jest.mock('../../src/db.service');
const db = require('../../src/db.service');
const settlement = require('../../src/modules/settlement.service');
const { NotYetSpecifiedError } = require('../../src/lib/errors');

describe('settlement.service', () => {
  beforeEach(() => jest.clearAllMocks());

  test('FR-46, FR-46a: calculateCommission applies the global % to item price only', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ value: '10' }] }); // commission_percent setting
    const { percent, commissionAmount } = await settlement.calculateCommission(5000);
    expect(percent).toBe(10);
    expect(commissionAmount).toBe(500);
  });

  test('FR-50a: calculateSettlement refuses a partial resolutionAmountToBuyer', async () => {
    await expect(
      settlement.calculateSettlement('order-1', { agreedItemPrice: 5000, resolutionAmountToBuyer: 2000 })
    ).rejects.toThrow(NotYetSpecifiedError);
  });

  test('FR-50a: calculateSettlement proceeds normally when resolutionAmountToBuyer is undefined (no dispute)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ value: '10' }] }); // commission_percent
    db.query.mockResolvedValueOnce({
      rows: [{ order_id: 'order-1', commission_percent: 10, commission_amount: 500, seller_net_payout: 4500 }],
    }); // INSERT settlements result

    const record = await settlement.calculateSettlement('order-1', { agreedItemPrice: 5000 });
    expect(record.seller_net_payout).toBe(4500);
  });

  test('FR-50: transaction setting reads use the caller client and fail for a missing key', async () => {
    const client = {
      query: jest.fn().mockResolvedValueOnce({
        rows: [
          { key: 'payout_hold_days', value: '5' },
          { key: 'complaint_window_days', value: '3' },
        ],
      }).mockResolvedValueOnce({ rows: [{ key: 'payout_hold_days', value: '5' }] }),
    };
    await expect(settlement.getSettingsForTransaction(client, [
      'payout_hold_days',
      'complaint_window_days',
    ])).resolves.toEqual({ payout_hold_days: '5', complaint_window_days: '3' });
    await expect(settlement.getSettingsForTransaction(client, [
      'payout_hold_days',
      'complaint_window_days',
    ])).rejects.toMatchObject({ statusCode: 404 });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('FR-48/FR-66: payout initiation must resolve the seller and pass the eligibility guard first', async () => {
    const guard = jest.fn().mockResolvedValue(true);
    db.query.mockResolvedValueOnce({ rows: [{ seller_id: 'seller-1' }] });
    db.query.mockResolvedValueOnce({ rows: [{ order_id: 'order-1', payout_initiated_by: 'admin-1' }] });
    await expect(settlement.initiateSellerPayout('order-1', 'admin-1', guard))
      .resolves.toMatchObject({ order_id: 'order-1' });
    expect(guard).toHaveBeenCalledWith('seller-1');
    expect(db.query.mock.calls[0][0]).toContain('FROM orders');
  });

  test('FR-48/FR-66: payout cannot bypass the eligibility guard', async () => {
    await expect(settlement.initiateSellerPayout('order-1', 'admin-1')).rejects.toThrow('eligibility guard is required');
    expect(db.query).not.toHaveBeenCalled();
  });
});
