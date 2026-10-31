/**
 * Owns: FR-32a, FR-63 and FR-63a reservation creation.
 * Tables owned: reservations, supported_delivery_cities
 */

const db = require('../db.service');
const settlement = require('./settlement.service');
const users = require('./users.service');
const { validatePhone } = require('../lib/authValidation');
const {
  NotFoundError,
  ValidationError,
  ForbiddenError,
  ConflictError,
  UnprocessableEntityError,
  ConfigurationError,
} = require('../lib/errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_SETTINGS = Object.freeze({
  reservationMinutes: '60',
  maxUnpaidReservations: '3',
  deliveryFeePkr: '300',
});

function requiredText(value, label, minLength, maxLength) {
  if (typeof value !== 'string') throw new ValidationError(`${label} must be a string.`);
  const text = value.trim();
  if (text.length < minLength || text.length > maxLength) {
    throw new ValidationError(`${label} must be ${minLength} to ${maxLength} characters.`);
  }
  return text;
}

function optionalText(value, label, maxLength) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError(`${label} must be a string.`);
  const text = value.trim();
  if (text.length > maxLength) throw new ValidationError(`${label} must be at most ${maxLength} characters.`);
  return text || null;
}

/** FR-32a: validate and normalize the immutable delivery address snapshot. */
function validateAddress(address) {
  if (!address || typeof address !== 'object' || Array.isArray(address)) {
    throw new ValidationError('A delivery address is required.');
  }
  if (typeof address.cityId !== 'string' || !UUID.test(address.cityId)) {
    throw new ValidationError('cityId must be a UUID.');
  }
  return {
    recipientName: requiredText(address.recipientName, 'recipientName', 2, 100),
    phone: validatePhone(address.phone),
    cityId: address.cityId,
    addressLine1: requiredText(address.addressLine1, 'addressLine1', 5, 200),
    addressLine2: optionalText(address.addressLine2, 'addressLine2', 200),
    postalCode: optionalText(address.postalCode, 'postalCode', 20),
  };
}

function parsePositiveInteger(value, key) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new ConfigurationError(`Invalid platform setting: ${key}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ConfigurationError(`Invalid platform setting: ${key}`);
  }
  return parsed;
}

function parseDeliveryFee(value) {
  if (typeof value !== 'string' || !/^\+?\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new ConfigurationError('Invalid platform setting: delivery_fee_pkr');
  }
  const integerPart = value.replace(/^\+/, '').split('.')[0].replace(/^0+/, '') || '0';
  if (integerPart.length > 10) {
    throw new ConfigurationError('Invalid platform setting: delivery_fee_pkr');
  }
  return value.replace(/^\+/, '');
}

/** FR-63: parse the documented defaults and exact NUMERIC(12,2) fee. */
function parseReservationSettings(values) {
  return {
    reservationMinutes: parsePositiveInteger(values.reservationMinutes, 'reservation_minutes'),
    maxUnpaidReservations: parsePositiveInteger(values.maxUnpaidReservations, 'max_unpaid_reservations'),
    deliveryFeePkr: parseDeliveryFee(values.deliveryFeePkr),
  };
}

async function getSettingOrDefault(key, fallback) {
  try {
    return await settlement.getSetting(key);
  } catch (error) {
    if (error instanceof NotFoundError) return fallback;
    throw error;
  }
}

async function readReservationSettings() {
  const [reservationMinutes, maxUnpaidReservations, deliveryFeePkr] = await Promise.all([
    getSettingOrDefault('reservation_minutes', DEFAULT_SETTINGS.reservationMinutes),
    getSettingOrDefault('max_unpaid_reservations', DEFAULT_SETTINGS.maxUnpaidReservations),
    getSettingOrDefault('delivery_fee_pkr', DEFAULT_SETTINGS.deliveryFeePkr),
  ]);
  return parseReservationSettings({ reservationMinutes, maxUnpaidReservations, deliveryFeePkr });
}

function validateExpectedPrice(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ValidationError('expectedPrice must be a decimal amount.');
  }
  const price = String(value);
  if (!/^\+?\d{1,10}(?:\.\d{1,2})?$/.test(price)) {
    throw new ValidationError('expectedPrice must be a decimal amount with at most two decimal places.');
  }
  return price.replace(/^\+/, '');
}

/** FR-32a, FR-63, FR-63a: atomically reserve a published listing for one buyer. */
async function buyListing(listingId, buyerId, input) {
  if (typeof listingId !== 'string' || !UUID.test(listingId)) {
    throw new ValidationError('listingId must be a UUID.');
  }
  const address = validateAddress(input?.address);
  const expectedPrice = validateExpectedPrice(input?.expectedPrice);
  const settings = await readReservationSettings();

  try {
    return await db.withTransaction(async (client) => {
      const { rows: listingRows } = await client.query(
        `SELECT id, seller_id, status, asking_price, asking_price > 0 AS positive_price
         FROM listings WHERE id = $1 FOR UPDATE`,
        [listingId]
      );
      const listing = listingRows[0];
      if (!listing) throw new NotFoundError('listing', listingId);
      if (listing.status !== 'published' || !listing.positive_price) {
        throw new ConflictError('Listing is not available for purchase.');
      }
      if (listing.seller_id === buyerId) {
        throw new ForbiddenError('You cannot buy your own listing.');
      }

      const city = await users.getCityById(address.cityId, client);
      if (!city) throw new NotFoundError('city', address.cityId);
      const { rows: supportedCityRows } = await client.query(
        'SELECT active FROM supported_delivery_cities WHERE city_id = $1',
        [address.cityId]
      );
      if (!supportedCityRows[0]?.active) {
        throw new UnprocessableEntityError('Delivery is not available in the selected city.');
      }

      if (expectedPrice !== undefined) {
        const { rows: priceRows } = await client.query(
          'SELECT $1::numeric = $2::numeric AS matches',
          [listing.asking_price, expectedPrice]
        );
        if (!priceRows[0].matches) {
          throw new ConflictError('The listing price changed. Refresh the listing before buying.');
        }
      }

      const { rows: buyerRows } = await client.query(
        'SELECT id FROM users WHERE id = $1 FOR UPDATE',
        [buyerId]
      );
      if (!buyerRows[0]) throw new NotFoundError('buyer', buyerId);

      const { rows: expiredRows } = await client.query(
        `UPDATE reservations
         SET status = 'expired', ended_at = now(), end_reason = 'expired'
         WHERE listing_id = $1 AND status = 'active' AND expires_at <= now()
         RETURNING id`,
        [listingId]
      );
      if (expiredRows.length) {
        await client.query(
          `UPDATE orders SET status = 'cancelled', cancelled_at = now()
           WHERE reservation_id = ANY($1::uuid[]) AND status IN ('reserved', 'payment_pending')`,
          [expiredRows.map((row) => row.id)]
        );
      }

      const { rows: liveRows } = await client.query(
        `SELECT id FROM reservations
         WHERE listing_id = $1
           AND (status = 'paid' OR (status = 'active' AND expires_at > now()))
         LIMIT 1 FOR UPDATE`,
        [listingId]
      );
      if (liveRows.length) throw new ConflictError('Listing is already reserved or sold.');

      const { rows: countRows } = await client.query(
        `SELECT count(*)::int AS count FROM reservations
         WHERE buyer_id = $1 AND status = 'active' AND expires_at > now()`,
        [buyerId]
      );
      if (countRows[0].count >= settings.maxUnpaidReservations) {
        throw new ConflictError('You have reached the active unpaid reservation limit.');
      }

      const { rows: reservationRows } = await client.query(
        `INSERT INTO reservations
           (listing_id, buyer_id, seller_id, status, item_price_snapshot,
            delivery_fee_snapshot, total_amount_snapshot, currency, recipient_name,
            recipient_phone, city_id, address_line1, address_line2, postal_code, expires_at)
         VALUES
           ($1, $2, $3, 'active', $4::numeric, $5::numeric, $4::numeric + $5::numeric,
            'PKR', $6, $7, $8, $9, $10, $11,
            now() + ($12 * interval '1 minute'))
         RETURNING id, item_price_snapshot, delivery_fee_snapshot, total_amount_snapshot,
                   currency, expires_at`,
        [
          listingId,
          buyerId,
          listing.seller_id,
          listing.asking_price,
          settings.deliveryFeePkr,
          address.recipientName,
          address.phone,
          address.cityId,
          address.addressLine1,
          address.addressLine2,
          address.postalCode,
          settings.reservationMinutes,
        ]
      );
      const reservation = reservationRows[0];

      const { rows: orderRows } = await client.query(
        `INSERT INTO orders
           (accepted_offer_id, reservation_id, listing_id, buyer_id, seller_id,
            agreed_item_price, delivery_fee, delivery_address,
            payment_method_preference, status)
         SELECT NULL, r.id, r.listing_id, r.buyer_id, r.seller_id,
                r.item_price_snapshot, r.delivery_fee_snapshot,
                '[reservation snapshot]', 'fixed_price_gateway', 'reserved'
         FROM reservations r WHERE r.id = $1
         RETURNING id`,
        [reservation.id]
      );

      return {
        orderId: orderRows[0].id,
        reservationId: reservation.id,
        status: 'reserved',
        expiresAt: reservation.expires_at,
        itemPrice: reservation.item_price_snapshot,
        deliveryFee: reservation.delivery_fee_snapshot,
        total: reservation.total_amount_snapshot,
        currency: reservation.currency,
        payment: null,
      };
    });
  } catch (error) {
    if (error?.code === '23505' && [
      'reservations_one_live_or_sold_per_listing',
      'orders_reservation_id_key',
    ].includes(error.constraint)) {
      throw new ConflictError('Listing is already reserved or sold.');
    }
    throw error;
  }
}

module.exports = { validateAddress, parseReservationSettings, buyListing };
