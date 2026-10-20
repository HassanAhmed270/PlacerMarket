/**
 * modules/negotiation.service.js
 *
 * Owns: FR-28 to FR-31 (specs.md section "5. Messaging & Negotiation")
 * Tables owned: conversations, messages, offers
 *
 * Cross-module dependency OUT: acceptOffer() hands off to orders.service.js
 * to create the Bag entry (FR-32) — accepting an offer is this module's
 * job, but "what happens after acceptance" belongs to Orders, not here.
 * Do not create rows in `orders` directly from this file.
 */

const db = require('../db.service');
const orders = require('./orders.service');
const eventBus = require('../lib/eventBus');
const events = require('../lib/events');
const { NotFoundError, ValidationError, ForbiddenError } = require('../lib/errors');

// FR-30: very small illustrative pattern set — phone numbers, emails, bare URLs.
// This is intentionally simple; a real implementation will need obfuscation
// handling (e.g. "o3zero..." spelled-out digits) which isn't specified yet.
const CONTACT_INFO_PATTERN = /(\+?\d[\d\s-]{7,}\d)|([\w.-]+@[\w.-]+\.\w+)|(https?:\/\/\S+|www\.\S+)/i;

// ---- FR-28: messaging ----

/** FR-28: open (or reuse) the buyer–seller conversation for a listing. */
async function startConversation(listingId, buyerId, sellerId) {
  const { rows } = await db.query(
    `INSERT INTO conversations (listing_id, buyer_id, seller_id) VALUES ($1,$2,$3)
     ON CONFLICT (listing_id, buyer_id) DO UPDATE SET listing_id = EXCLUDED.listing_id
     RETURNING *`,
    [listingId, buyerId, sellerId]
  );
  return rows[0];
}

/** FR-28, FR-30: send a message; flags (but does not silently strip) contact-info bypass attempts. */
async function sendMessage(conversationId, senderId, body) {
  const wasFlagged = CONTACT_INFO_PATTERN.test(body); // FR-30
  const { rows } = await db.query(
    `INSERT INTO messages (conversation_id, sender_id, body, was_flagged_bypass)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [conversationId, senderId, body, wasFlagged]
  );
  eventBus.emit(events.MESSAGE_SENT, { conversationId, senderId, wasFlagged });
  return rows[0];
}

// ---- FR-29, FR-31: negotiation (offer / counter / accept) ----

/** FR-29: no fixed Buy Now path — this is the only way a sale starts. */
async function makeOffer(conversationId, listingId, buyerId, amount) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO offers (conversation_id, listing_id, proposed_by, amount, status)
       VALUES ($1, $2, $3, $4, 'pending') RETURNING *`,
      [conversationId, listingId, buyerId, amount]
    );
    await eventBus.emitAsync(events.OFFER_CREATED, { offerId: rows[0].id, listingId }, { transaction: client });
    return rows[0];
  });
}

/** FR-29: either party can counter; chained via parent_offer_id. */
async function counterOffer(parentOfferId, proposedBy, amount) {
  const { rows: parentRows } = await db.query('SELECT * FROM offers WHERE id = $1', [parentOfferId]);
  const parent = parentRows[0];
  if (!parent) throw new NotFoundError('offer', parentOfferId);
  if (parent.status !== 'pending') {
    throw new ValidationError('Only a pending offer can be countered');
  }
  await db.query(`UPDATE offers SET status = 'countered' WHERE id = $1`, [parentOfferId]);

  const { rows } = await db.query(
    `INSERT INTO offers (conversation_id, listing_id, proposed_by, amount, status, parent_offer_id)
     VALUES ($1, $2, $3, $4, 'pending', $5) RETURNING *`,
    [parent.conversation_id, parent.listing_id, proposedBy, amount, parentOfferId]
  );
  eventBus.emit(events.OFFER_COUNTERED, { offerId: rows[0].id, parentOfferId });
  return rows[0];
}

/**
 * FR-29: accepting an offer is the only path to a sale. Hands off to
 * orders.service.js to create the Bag entry (FR-32) — this file does not
 * touch the `orders` table directly.
 */
async function acceptOffer(offerId, acceptedBy) {
  const { rows } = await db.query(
    `UPDATE offers SET status = 'accepted' WHERE id = $1 AND status = 'pending' RETURNING *`,
    [offerId]
  );
  const offer = rows[0];
  if (!offer) throw new ValidationError('Offer is not in a pending state and cannot be accepted');

  eventBus.emit(events.OFFER_ACCEPTED, { offerId, listingId: offer.listing_id });
  return orders.createBagEntry(offer); // FR-32, cross-module hand-off
}

/** FR-31: negotiation history tied to the listing/order, reused as dispute evidence by disputes.service.js. */
async function getNegotiationHistory(listingId) {
  const { rows } = await db.query(
    `SELECT o.* FROM offers o WHERE o.listing_id = $1 ORDER BY o.created_at ASC`,
    [listingId]
  );
  const { rows: msgs } = await db.query(
    `SELECT m.* FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE c.listing_id = $1 ORDER BY m.created_at ASC`,
    [listingId]
  );
  return { offers: rows, messages: msgs };
}

module.exports = {
  startConversation,
  sendMessage,
  makeOffer,
  counterOffer,
  acceptOffer,
  getNegotiationHistory,
};
