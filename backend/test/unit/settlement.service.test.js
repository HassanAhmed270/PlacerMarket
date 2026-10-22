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
