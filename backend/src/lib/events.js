/**
 * lib/events.js
 *
 * Single source of truth for event names used on the in-process event bus
 * (see lib/eventBus.js). Any module.service.js that fires or listens for an
 * event MUST import the name from here — never inline a string literal like
 * 'order.status_changed' directly in a service file. This is what keeps the
 * emitter side and the listener side from silently drifting apart.
 *
 * Convention: '<owning module>.<past-tense event>'
 */

module.exports = {
  // Module 1: Identity & Users
  SELLER_APPLICATION_STATUS_CHANGED: 'seller_application.status_changed', // FR-07
  SELLER_SUSPENDED: 'seller.suspended', // FR-10

  // Module 3: Listings
  LISTING_STATUS_CHANGED: 'listing.status_changed', // FR-19, FR-21

  // Module 5: Messaging & Negotiation
  OFFER_CREATED: 'offer.created', // FR-29
  OFFER_COUNTERED: 'offer.countered', // FR-29
  OFFER_ACCEPTED: 'offer.accepted', // FR-29
  MESSAGE_SENT: 'message.sent', // FR-28

  // Module 6: Orders
  ORDER_STATUS_CHANGED: 'order.status_changed', // FR-33
  ORDER_CANCELLED: 'order.cancelled', // FR-33a

  // Module 8: Delivery
  DELIVERY_STATUS_CHANGED: 'delivery.status_changed', // FR-41, FR-42

  // Module 9: Disputes
  DISPUTE_FILED: 'dispute.filed', // FR-43
  DISPUTE_RESOLVED: 'dispute.resolved', // FR-45

  // Module 9a: Payout Hold
  PAYOUT_HELD: 'payout.held', // FR-45b
  PAYOUT_RELEASED: 'payout.released', // FR-47
  PAYOUT_FORCE_RELEASED: 'payout.force_released', // FR-45e
};
