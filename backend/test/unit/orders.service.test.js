jest.mock('../../src/db.service', () => ({
  withTransaction: jest.fn(),
}));

const orders = require('../../src/modules/orders.service');

describe('FR-61, FR-62 order funding transitions', () => {
  test('FR-61, FR-62: funding is restricted to the payment-pending reservation and sets the 72-hour deadline', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [{ id: 'order-1' }] }),
    };

    await expect(orders.fundReservationOrder(client, 'order-1', 'reservation-1'))
      .resolves.toEqual({ id: 'order-1' });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'payment_pending'"),
      ['order-1', 'reservation-1']
    );
    expect(client.query.mock.calls[0][0]).toContain("INTERVAL '72 hours'");
  });

  test('FR-61, FR-62: expiry cancellation changes only an unpaid reservation-backed order', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [{ id: 'order-1' }] }),
    };

    await expect(orders.cancelUnpaidReservationOrder(client, 'order-1'))
      .resolves.toEqual({ id: 'order-1' });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("status IN ('reserved', 'payment_pending')"),
      ['order-1']
    );
  });
});
