jest.mock('../../src/db.service');
const db = require('../../src/db.service');
const settlement = require('../../src/modules/settlement.service');
const { ValidationError } = require('../../src/lib/errors');

describe('settlement.service', () => {
  beforeEach(() => jest.clearAllMocks());

  test('FR-46, FR-46a: calculateCommission applies the global % to item price only', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ value: '5' }] }); // commission_percent setting
    const result = await settlement.calculateCommission('5000.00');
    expect(result).toEqual({ percent: '5', commissionAmount: '250.00' });
  });

  test.each([
    { label: 'string zero', value: '0', valid: true, stored: '0' },
    { label: 'string integer', value: '5', valid: true, stored: '5' },
    { label: 'string decimal', value: '7.5', valid: true, stored: '7.5' },
    { label: 'string maximum', value: '100', valid: true, stored: '100' },
    { label: 'string maximum with trailing zeroes', value: '100.00', valid: true, stored: '100.00' },
    { label: 'number decimal', value: 7.5, valid: true, stored: '7.5' },
    { label: 'number zero', value: 0, valid: true, stored: '0' },
    { label: 'number maximum', value: 100, valid: true, stored: '100' },
    { label: 'three decimal places', value: '12.345', valid: false },
    { label: 'exponent string', value: '1e1', valid: false },
    { label: 'leading whitespace', value: ' 5', valid: false },
    { label: 'hex string', value: '0x10', valid: false },
    { label: 'trailing decimal point', value: '5.', valid: false },
    { label: 'negative string', value: '-1', valid: false },
    { label: 'above maximum', value: '100.01', valid: false },
    { label: 'boolean', value: true, valid: false },
    { label: 'null', value: null, valid: false },
    { label: 'object', value: {}, valid: false },
    { label: 'array', value: [], valid: false },
    { label: 'undefined', value: undefined, valid: false },
    { label: 'number outside decimal format', value: 1e-7, valid: false },
    { label: 'number above maximum', value: 100.01, valid: false },
  ])('FR-50: commission percent $label is validated without changing calculation math', async ({
    value, valid, stored,
  }) => {
    if (!valid) {
      await expect(settlement.adjustCommissionPercent(value, 'admin-1')).rejects.toBeInstanceOf(ValidationError);
      expect(db.query).not.toHaveBeenCalled();
      expect(() => settlement.calculateReservationSettlement('100.00', value)).toThrow(ValidationError);
      return;
    }

    db.query.mockResolvedValueOnce({ rows: [{ value: stored }] });
    await expect(settlement.adjustCommissionPercent(value, 'admin-1'))
      .resolves.toEqual({ value: stored });
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(settlement.calculateReservationSettlement('100.00', value).commissionPercent).toBe(stored);
  });

  test('FR-50: a malformed stored commission percent is rejected during a calculation', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ value: '1e1' }] });
    await expect(settlement.calculateCommission('100.00')).rejects.toBeInstanceOf(ValidationError);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('FR-46, FR-50a: legacy commission and settlement reject JavaScript number amounts', async () => {
    db.query.mockResolvedValue({ rows: [{ value: '5' }] });
    await expect(settlement.calculateCommission(5000)).rejects.toThrow(ValidationError);
    await expect(settlement.calculateSettlement('order-1', {
      agreedItemPrice: 1000,
    })).rejects.toThrow(ValidationError);
    await expect(settlement.calculateSettlement('order-1', {
      agreedItemPrice: '1000.00',
      resolutionAmountToBuyer: 200,
    })).rejects.toThrow(ValidationError);
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  test('FR-47: reservation settlement computes exact decimal-string amounts from item price only', () => {
    expect(settlement.calculateReservationSettlement('1250.50', '5.00')).toEqual({
      commissionPercent: '5.00',
      commissionAmount: '62.53',
      sellerNetAmount: '1187.97',
      refundedItemAmount: '0.00',
    });
    expect(settlement.calculateReservationSettlement('0.05', '5')).toEqual({
      commissionPercent: '5',
      commissionAmount: '0.00',
      sellerNetAmount: '0.05',
      refundedItemAmount: '0.00',
    });
  });

  test('FR-47: monetary inputs reject JavaScript numbers', () => {
    expect(() => settlement.calculateReservationSettlement(1250.5, '5.00'))
      .toThrow(ValidationError);
  });

  test('FR-46, FR-46a: commission is calculated on the item price only at 5%', () => {
    const table = [
      { price: '1000', deliveryFee: '300', expectedCommission: '50.00', expectedNet: '950.00' },
      { price: '1000.00', deliveryFee: '500.00', expectedCommission: '50.00', expectedNet: '950.00' },
    ];
    for (const { price, expectedCommission, expectedNet } of table) {
      const res = settlement.calculateReservationSettlement(price, '5');
      expect(res.commissionAmount).toBe(expectedCommission);
      expect(res.sellerNetAmount).toBe(expectedNet);
      expect(res.refundedItemAmount).toBe('0.00');
    }
  });

  test('FR-50a: partial refund 200 on price 1000 gives commission 40.00 and net 760.00', () => {
    const res = settlement.calculateReservationSettlement('1000', '5', '200');
    expect(res).toEqual({
      commissionPercent: '5',
      commissionAmount: '40.00',
      sellerNetAmount: '760.00',
      refundedItemAmount: '200.00',
    });
  });

  test('FR-50a: partial refund equal to the item price produces no settlement', () => {
    expect(settlement.calculateReservationSettlement('1000', '5', '1000')).toBeNull();
  });

  test('FR-50a: refunds above the item price are rejected', () => {
    expect(() => settlement.calculateReservationSettlement('1000', '5', '1000.01')).toThrow(ValidationError);
    expect(() => settlement.calculateReservationSettlement('1000', '5', '1500')).toThrow(ValidationError);
  });

  test('FR-46: rounding follows two decimals half-up', () => {
    const table = [
      { price: '33.30', percent: '5', expectedCommission: '1.67', expectedNet: '31.63' },
      { price: '33.10', percent: '5', expectedCommission: '1.66', expectedNet: '31.44' },
      { price: '10.15', percent: '5', expectedCommission: '0.51', expectedNet: '9.64' },
      { price: '10.05', percent: '5', expectedCommission: '0.50', expectedNet: '9.55' },
    ];
    for (const { price, percent, expectedCommission, expectedNet } of table) {
      const res = settlement.calculateReservationSettlement(price, percent);
      expect(res.commissionAmount).toBe(expectedCommission);
      expect(res.sellerNetAmount).toBe(expectedNet);
    }
  });

  test('FR-50a: calculateSettlement supports partial refunds', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ value: '5' }] }); // commission_percent
    db.query.mockResolvedValueOnce({
      rows: [{ order_id: 'order-1', commission_percent: 5, commission_amount: 40, seller_net_payout: 760, refunded_item_amount: 200 }],
    });

    const record = await settlement.calculateSettlement('order-1', {
      agreedItemPrice: '1000.00',
      resolutionAmountToBuyer: '200.00',
    });
    expect(record.seller_net_payout).toBe(760);
    expect(db.query.mock.calls[1][1]).toEqual(['order-1', '5', '40.00', '760.00', '200.00']);
  });

  test('FR-50a: calculateSettlement proceeds normally when resolutionAmountToBuyer is undefined (no dispute)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ value: '5' }] }); // commission_percent
    db.query.mockResolvedValueOnce({
      rows: [{ order_id: 'order-1', commission_percent: 5, commission_amount: 250, seller_net_payout: 4750, refunded_item_amount: 0 }],
    }); // INSERT settlements result

    const record = await settlement.calculateSettlement('order-1', { agreedItemPrice: '5000.00' });
    expect(record.seller_net_payout).toBe(4750);
    expect(db.query.mock.calls[1][1]).toEqual(['order-1', '5', '250.00', '4750.00', '0.00']);
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
