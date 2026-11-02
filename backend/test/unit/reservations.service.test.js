const {
  validateAddress,
  parseReservationSettings,
} = require('../../src/modules/reservations.service');

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
