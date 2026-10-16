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
});
