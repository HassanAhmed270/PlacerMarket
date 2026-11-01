/** FR-22, FR-25, FR-27, FR-63, FR-73, FR-80a: shared listing availability SQL. */

const LEGACY_DISCOVERY_RESERVED_ORDER_STATUSES = Object.freeze([
  'bag', 'order_placed', 'seller_preparing', 'handed_to_delivery',
  'out_for_delivery', 'delivered', 'held',
]);
const LEGACY_SEARCH_RESERVED_ORDER_STATUSES = Object.freeze([
  'order_placed', 'seller_preparing',
]);
const LEGACY_ORDER_SYNC_RESERVED_STATUSES = Object.freeze([
  'order_placed', 'seller_preparing', 'handed_to_delivery', 'out_for_delivery',
]);
const LEGACY_SOLD_ORDER_STATUSES = Object.freeze(['delivered', 'held', 'completed']);

function listingAlias(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]*$/i.test(value)) {
    throw new TypeError('A valid listing SQL alias is required.');
  }
  return value;
}

function orderStatusList(statuses) {
  if (!Array.isArray(statuses) || statuses.some((status) => typeof status !== 'string' || !/^[a-z_]+$/.test(status))) {
    throw new TypeError('Valid order statuses are required.');
  }
  return statuses.map((status) => `'${status}'`).join(', ');
}

/** FR-63: SQL predicate for an active reservation that has not expired by database time. */
function activeReservationExistsSql(alias = 'l') {
  const listing = listingAlias(alias);
  return `EXISTS (
    SELECT 1 FROM reservations active_reservation
    WHERE active_reservation.listing_id = ${listing}.id
      AND active_reservation.status = 'active'
      AND active_reservation.expires_at > now()
  )`;
}

/** FR-22, FR-25, FR-27, FR-80a: include the established legacy reservation rule. */
function reservedPredicateSql(alias = 'l', legacyStatuses = LEGACY_DISCOVERY_RESERVED_ORDER_STATUSES) {
  const listing = listingAlias(alias);
  return `(${activeReservationExistsSql(listing)} OR EXISTS (
    SELECT 1 FROM orders legacy_reserved_order
    WHERE legacy_reserved_order.listing_id = ${listing}.id
      AND legacy_reserved_order.status IN (${orderStatusList(legacyStatuses)})
  ))`;
}

/** FR-63, FR-80a: SQL predicate for a paid, non-cancelled reservation order. */
function paidReservationExistsSql(alias = 'l') {
  const listing = listingAlias(alias);
  return `EXISTS (
    SELECT 1
    FROM reservations paid_reservation
    JOIN orders paid_order ON paid_order.reservation_id = paid_reservation.id
    WHERE paid_reservation.listing_id = ${listing}.id
      AND paid_reservation.status = 'paid'
      AND paid_order.status <> 'cancelled'
  )`;
}

/** FR-22, FR-25, FR-27, FR-80a: preserve legacy sold behavior from completed delivery orders. */
function soldPredicateSql(alias = 'l') {
  const listing = listingAlias(alias);
  return `(${paidReservationExistsSql(listing)} OR EXISTS (
    SELECT 1 FROM orders legacy_sold_order
    WHERE legacy_sold_order.listing_id = ${listing}.id
      AND legacy_sold_order.status IN (${orderStatusList(LEGACY_SOLD_ORDER_STATUSES)})
  ))`;
}

/** FR-80a: project the latest active reservation expiry; readers compare it with now(). */
function latestActiveReservationExpirySql(alias = 'l') {
  const listing = listingAlias(alias);
  return `(SELECT max(active_reservation.expires_at)
          FROM reservations active_reservation
          WHERE active_reservation.listing_id = ${listing}.id
            AND active_reservation.status = 'active')`;
}

/** FR-20, FR-73: active reservations or paid reservations block seller listing actions. */
function reservationBlocksSellerActionSql(alias = 'l') {
  return `(${activeReservationExistsSql(alias)} OR ${paidReservationExistsSql(alias)})`;
}

/** FR-80a: preserve the prior search-index reservation rule. */
function legacySearchReservationExistsSql(alias = 'l') {
  return `EXISTS (
    SELECT 1 FROM orders legacy_search_order
    WHERE legacy_search_order.listing_id = ${listingAlias(alias)}.id
      AND legacy_search_order.status IN (${orderStatusList(LEGACY_SEARCH_RESERVED_ORDER_STATUSES)})
  )`;
}

module.exports = {
  LEGACY_DISCOVERY_RESERVED_ORDER_STATUSES,
  LEGACY_ORDER_SYNC_RESERVED_STATUSES,
  activeReservationExistsSql,
  legacySearchReservationExistsSql,
  latestActiveReservationExpirySql,
  paidReservationExistsSql,
  reservationBlocksSellerActionSql,
  reservedPredicateSql,
  soldPredicateSql,
};
