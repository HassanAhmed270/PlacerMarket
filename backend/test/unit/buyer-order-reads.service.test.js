jest.mock('../../src/db.service', () => ({
  read: jest.fn(),
}));

const db = require('../../src/db.service');
const orders = require('../../src/modules/orders.service');
const reservations = require('../../src/modules/reservations.service');
const listings = require('../../src/modules/listings.service');

const ORDER_ID = '123e4567-e89b-42d3-a456-426614174001';
const BUYER_ID = '123e4567-e89b-42d3-a456-426614174002';
const RESERVATION_ID = '123e4567-e89b-42d3-a456-426614174003';
const LISTING_ID = '123e4567-e89b-42d3-a456-426614174004';

afterEach(() => jest.clearAllMocks());

describe('FR-60a delivery city reads', () => {
  test('FR-60a: supported delivery cities return only their public id and name', async () => {
    db.read.mockResolvedValue({ rows: [{ id: 'city-id', name: 'Lahore' }] });

    await expect(reservations.listActiveSupportedDeliveryCities())
      .resolves.toEqual([{ id: 'city-id', name: 'Lahore' }]);
    expect(db.read.mock.calls[0][0]).toContain('WHERE supported.active = true');
    expect(db.read.mock.calls[0][0]).toContain('ORDER BY city.name');
  });
});

describe('FR-61, FR-62 buyer order reads', () => {
  test('FR-61, FR-62: order summary lookup is scoped to the buyer and reservation-backed orders', async () => {
    db.read.mockResolvedValue({
      rows: [{
        id: ORDER_ID,
        listing_id: LISTING_ID,
        reservation_id: RESERVATION_ID,
        status: 'reserved',
        handover_deadline_at: null,
        created_at: '2026-11-04T20:00:00.000Z',
      }],
    });

    await expect(orders.getBuyerReservationOrder(ORDER_ID, BUYER_ID)).resolves.toEqual({
      orderId: ORDER_ID,
      listingId: LISTING_ID,
      reservationId: RESERVATION_ID,
      status: 'reserved',
      handoverDeadlineAt: null,
      createdAt: '2026-11-04T20:00:00.000Z',
    });
    expect(db.read.mock.calls[0][0]).toContain('buyer_id = $2 AND reservation_id IS NOT NULL');
    expect(db.read.mock.calls[0][1]).toEqual([ORDER_ID, BUYER_ID]);
  });

  test('FR-61, FR-62: mine returns exact decimal-string amounts without seller fields', async () => {
    db.read.mockResolvedValue({
      rows: [{
        order_id: ORDER_ID,
        listing_id: LISTING_ID,
        title: 'Listing title',
        status: 'reserved',
        total_amount_snapshot: '1550.50',
        currency: 'PKR',
        expires_at: '2026-11-04T21:00:00.000Z',
        created_at: '2026-11-04T20:00:00.000Z',
      }],
    });

    await expect(orders.getBuyerReservationOrders(BUYER_ID)).resolves.toEqual([{
      orderId: ORDER_ID,
      listingId: LISTING_ID,
      title: 'Listing title',
      status: 'reserved',
      total: '1550.50',
      currency: 'PKR',
      reservationExpiresAt: '2026-11-04T21:00:00.000Z',
      createdAt: '2026-11-04T20:00:00.000Z',
    }]);
    expect(db.read.mock.calls[0][1]).toEqual([BUYER_ID, 20]);
  });

  test('FR-61, FR-62: reservation snapshots expose only the buyer delivery subset and decimal strings', async () => {
    db.read.mockResolvedValue({
      rows: [{
        status: 'active',
        expires_at: '2026-11-04T21:00:00.000Z',
        item_price_snapshot: '1250.50',
        delivery_fee_snapshot: '300.00',
        total_amount_snapshot: '1550.50',
        currency: 'PKR',
        recipient_name: 'Buyer Name',
        city: 'Lahore',
        address_line1: '12 Demo Street',
      }],
    });

    await expect(reservations.getBuyerReservationSnapshot(RESERVATION_ID, BUYER_ID)).resolves.toEqual({
      status: 'active',
      expiresAt: '2026-11-04T21:00:00.000Z',
      itemPrice: '1250.50',
      deliveryFee: '300.00',
      total: '1550.50',
      currency: 'PKR',
      recipientName: 'Buyer Name',
      city: 'Lahore',
      addressLine1: '12 Demo Street',
    });
  });

  test('FR-61, FR-62: missing buyer-owned order and listing records return 404', async () => {
    db.read.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });

    await expect(orders.getBuyerReservationOrder(ORDER_ID, BUYER_ID)).rejects.toMatchObject({ statusCode: 404 });
    await expect(listings.getBuyerOrderListingSummary(LISTING_ID)).rejects.toMatchObject({ statusCode: 404 });
  });
});
