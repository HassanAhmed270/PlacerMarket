const {
  validateAddress,
  parseReservationSettings,
} = require('../../src/modules/reservations.service');
const db = require('../../src/db.service');
const users = require('../../src/modules/users.service');
const reservations = require('../../src/modules/reservations.service');

describe('FR-68 Admin order reservation snapshot', () => {
  test('FR-68: returns the immutable address and decimal-string amount snapshots through their owners', async () => {
    const read = jest.spyOn(db, 'read').mockResolvedValue({ rows: [{
      id: 'reservation-1',
      status: 'paid',
      expires_at: new Date('2026-11-06T12:00:00Z'),
      item_price_snapshot: '1200.50',
      delivery_fee_snapshot: '300.00',
      total_amount_snapshot: '1500.50',
      recipient_name: 'Recipient',
      recipient_phone: '+15551234567',
      city_id: 'city-1',
      address_line1: '12 Main Street',
      address_line2: null,
      postal_code: null,
    }] });
    const city = jest.spyOn(users, 'getCityById').mockResolvedValue({ id: 'city-1', name: 'Test City' });
    try {
      const reservationId = '123e4567-e89b-42d3-a456-426614174000';
      await expect(reservations.getAdminOrderReservationSnapshot(reservationId)).resolves.toEqual({
        id: 'reservation-1',
        status: 'paid',
        expiresAt: new Date('2026-11-06T12:00:00Z'),
        amounts: { itemPrice: '1200.50', deliveryFee: '300.00', total: '1500.50' },
        deliveryAddress: {
          recipientName: 'Recipient',
          phone: '+15551234567',
          city: 'Test City',
          addressLine1: '12 Main Street',
          addressLine2: null,
          postalCode: null,
        },
      });
      expect(read).toHaveBeenCalledWith(expect.stringContaining('FROM reservations'), [reservationId]);
      expect(city).toHaveBeenCalledWith('city-1');
    } finally {
      read.mockRestore();
      city.mockRestore();
    }
  });
});

describe('FR-32a reservation input validation', () => {
  test('FR-32a: address values are trimmed and optional blank fields normalize to null', () => {
    expect(validateAddress({
      recipientName: ' Recipient Name ',
      phone: ' +15551234567 ',
      cityId: '123e4567-e89b-42d3-a456-426614174000',
      addressLine1: ' 12 Main Street ',
      addressLine2: ' ',
      postalCode: '',
    })).toEqual({
      recipientName: 'Recipient Name',
      phone: '+15551234567',
      cityId: '123e4567-e89b-42d3-a456-426614174000',
      addressLine1: '12 Main Street',
      addressLine2: null,
      postalCode: null,
    });
  });

  test('FR-32a: address length and type validation rejects malformed fields', () => {
    expect(() => validateAddress(null)).toThrow('A delivery address is required.');
    expect(() => validateAddress({
      recipientName: 'X',
      phone: '+15551234567',
      cityId: '123e4567-e89b-42d3-a456-426614174000',
      addressLine1: '12 Main Street',
    })).toThrow(/recipientName/);
    expect(() => validateAddress({
      recipientName: 'Recipient Name',
      phone: 'invalid',
      cityId: '123e4567-e89b-42d3-a456-426614174000',
      addressLine1: '12 Main Street',
    })).toThrow(/international phone format/);
  });
});

describe('FR-86 Admin delivery-city management', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('FR-86: lists all cities and defaults missing supported rows to inactive', async () => {
    const rows = [{ cityId: 'city-1', name: 'Inactive city', active: false }];
    const read = jest.spyOn(db, 'read').mockResolvedValue({ rows });

    await expect(reservations.listAdminSupportedDeliveryCities()).resolves.toEqual(rows);
    expect(read).toHaveBeenCalledWith(expect.stringContaining('LEFT JOIN supported_delivery_cities'));
    expect(read.mock.calls[0][0]).toContain('COALESCE(supported.active, false)');
    expect(read.mock.calls[0][0]).toContain('ORDER BY city.name, city.id');
  });

  test('FR-86: validates and upserts city support in the owning transaction', async () => {
    const cityId = '123e4567-e89b-42d3-a456-426614174000';
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ id: cityId }] })
        .mockResolvedValueOnce({ rows: [{ city_id: cityId, active: true }] }),
    };
    const transaction = jest.spyOn(db, 'withTransaction').mockImplementation((callback) => callback(client));

    await expect(reservations.setSupportedDeliveryCity(cityId, true)).resolves.toEqual({
      cityId,
      active: true,
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenNthCalledWith(1, expect.stringContaining('FOR KEY SHARE'), [cityId]);
    expect(client.query).toHaveBeenNthCalledWith(2, expect.stringContaining('ON CONFLICT (city_id)'), [cityId, true]);
  });

  test('FR-86: repeated city support updates return the idempotent setting', async () => {
    const cityId = '123e4567-e89b-42d3-a456-426614174000';
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ id: cityId }] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    jest.spyOn(db, 'withTransaction').mockImplementation((callback) => callback(client));

    await expect(reservations.setSupportedDeliveryCity(cityId, true)).resolves.toEqual({
      cityId,
      active: true,
    });
  });

  test('FR-86: rejects an unknown city and invalid city settings', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    jest.spyOn(db, 'withTransaction').mockImplementation((callback) => callback(client));

    await expect(reservations.setSupportedDeliveryCity(
      '123e4567-e89b-42d3-a456-426614174000', true
    )).rejects.toThrow(/city/);
    await expect(reservations.setSupportedDeliveryCity('not-a-uuid', true)).rejects.toThrow(/UUID/);
    await expect(reservations.setSupportedDeliveryCity(
      '123e4567-e89b-42d3-a456-426614174000', 'true'
    )).rejects.toThrow(/boolean/);
  });
});

describe('FR-63 reservation setting parsing', () => {
  test('FR-63: valid fee settings remain exact decimal strings', () => {
    expect(parseReservationSettings({
      reservationMinutes: '60',
      maxUnpaidReservations: '3',
      deliveryFeePkr: '300.00',
    })).toEqual({
      reservationMinutes: 60,
      maxUnpaidReservations: 3,
      deliveryFeePkr: '300.00',
    });
  });

  test.each([
    [{ reservationMinutes: '0', maxUnpaidReservations: '3', deliveryFeePkr: '300' }],
    [{ reservationMinutes: '60.5', maxUnpaidReservations: '3', deliveryFeePkr: '300' }],
    [{ reservationMinutes: '60', maxUnpaidReservations: '3', deliveryFeePkr: '-1' }],
    [{ reservationMinutes: '60', maxUnpaidReservations: '3', deliveryFeePkr: '300.001' }],
    [{ reservationMinutes: '60', maxUnpaidReservations: '3', deliveryFeePkr: '10000000000.00' }],
  ])('FR-63: invalid settings are rejected instead of guessed', (values) => {
    expect(() => parseReservationSettings(values)).toThrow();
  });
});

describe('FR-61 reservation funding transitions', () => {
  test('FR-61: paid transition is conditional on an active unexpired reservation', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [{ id: 'reservation-1' }] }),
    };
    const reservations = require('../../src/modules/reservations.service');

    await expect(reservations.markReservationPaid(client, 'reservation-1'))
      .resolves.toEqual({ id: 'reservation-1' });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'active' AND expires_at > now()"),
      ['reservation-1']
    );
  });

  test('FR-61: late-payment expiry only transitions an active already-expired reservation', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [{ id: 'reservation-1' }] }),
    };
    const reservations = require('../../src/modules/reservations.service');

    await expect(reservations.expireReservationForLatePayment(client, 'reservation-1'))
      .resolves.toEqual({ id: 'reservation-1' });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'active' AND expires_at <= now()"),
      ['reservation-1']
    );
  });
});
