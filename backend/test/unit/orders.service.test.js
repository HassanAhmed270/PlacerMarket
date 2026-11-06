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

describe('FR-68 reservation-backed delivery transition', () => {
  test('FR-68: delivery records delivered_at and persists the hold-start order status', async () => {
    const deliveredAt = new Date('2026-11-06T12:00:00.000Z');
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ id: 'order-1', delivered_at: deliveredAt }] })
        .mockResolvedValueOnce({ rows: [{ id: 'order-1', status: 'held', delivered_at: deliveredAt }] }),
    };

    await expect(orders.markReservationOrderDelivered(client, 'order-1'))
      .resolves.toEqual({ id: 'order-1', status: 'held', delivered_at: deliveredAt });
    expect(client.query.mock.calls[0][0]).toContain("SET status = 'delivered', delivered_at = now()");
    expect(client.query.mock.calls[0][0]).toContain("status IN ('handed_to_delivery', 'out_for_delivery')");
    expect(client.query.mock.calls[0][0]).toContain('delivered_at IS NULL');
    expect(client.query.mock.calls[0][0]).toContain('handed_over_at IS NOT NULL');
    expect(client.query.mock.calls[1][0]).toContain("SET status = 'held'");
  });

  test('FR-68: a stale delivery update leaves the order unchanged', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await expect(orders.markReservationOrderDelivered(client, 'order-1')).resolves.toBeNull();
    expect(client.query).toHaveBeenCalledTimes(1);
  });
});
