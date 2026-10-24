/**
 * modules/negotiation.service.js
 *
 * Owns: FR-28 to FR-31 (specs.md section "5. Messaging & Negotiation")
 * Tables owned: conversations, messages, offers, contact_info_block_attempts
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

function assertOffersEnabled() {
  if (process.env.OFFERS_ENABLED !== '1') {
    const error = new ValidationError('Offers are disabled by the OFFERS_ENABLED feature flag');
    error.statusCode = 503;
    throw error;
  }
}

const PHONE_PATTERN = /(?:^|[^\w])\+?\d[\d ().-]*\d(?:$|[^\w])/g;
const EMAIL_PATTERN = /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i;
const LINK_PATTERN = /\b(?:https?:\/\/|www\.)[^\s]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/i;

/** FR-30: detect phone numbers, email addresses, and links without blocking prices or measurements. */
function containsContactInfo(body) {
  if (EMAIL_PATTERN.test(body) || LINK_PATTERN.test(body)) return true;
  for (const match of body.matchAll(PHONE_PATTERN)) {
    if ((match[0].match(/\d/g) || []).length >= 10) return true;
  }
  return false;
}

// ---- FR-28: messaging ----

/** FR-28: open (or reuse) the buyer–seller conversation for a listing. */
async function startConversation(listingId, buyerId) {
  return db.withTransaction(async (client) => {
    const { rows: listings } = await client.query(
      'SELECT id, seller_id, status FROM listings WHERE id = $1 FOR SHARE',
      [listingId]
    );
    const listing = listings[0];
    if (!listing) throw new NotFoundError('listing', listingId);
    if (listing.status !== 'published') {
      throw new ValidationError('Conversations can only be started for published listings.');
    }
    if (listing.seller_id === buyerId) {
      throw new ForbiddenError('You cannot start a conversation with yourself.');
    }
    const { rows } = await client.query(
      `INSERT INTO conversations (listing_id, buyer_id, seller_id) VALUES ($1, $2, $3)
       ON CONFLICT (listing_id, buyer_id) DO UPDATE
       SET seller_id = EXCLUDED.seller_id
       RETURNING *`,
      [listingId, buyerId, listing.seller_id]
    );
    return rows[0];
  });
}

/** FR-28, FR-30: persist a message only after participant and listing checks. */
async function sendMessage(conversationId, senderId, body) {
  if (typeof body !== 'string' || !body.trim() || Array.from(body).length > 1000) {
    throw new ValidationError('Message must contain 1 to 1000 characters.');
  }
  const result = await db.withTransaction(async (client) => {
    const { rows: conversations } = await client.query(
      `SELECT c.id, c.listing_id, l.status
       FROM conversations c
       JOIN listings l ON l.id = c.listing_id
       WHERE c.id = $1 AND (c.buyer_id = $2 OR c.seller_id = $2)
       FOR SHARE OF c, l`,
      [conversationId, senderId]
    );
    const conversation = conversations[0];
    if (!conversation) throw new NotFoundError('conversation', conversationId);
    if (conversation.status !== 'published') {
      throw new ValidationError('This conversation is read-only because its listing is no longer published.');
    }
    if (containsContactInfo(body)) {
      await client.query(
        `INSERT INTO contact_info_block_attempts (user_id, attempt_count)
         VALUES ($1, 1)
         ON CONFLICT (user_id) DO UPDATE
         SET attempt_count = contact_info_block_attempts.attempt_count + 1,
             updated_at = now()`,
        [senderId]
      );
      return { blocked: true };
    }
    const { rows } = await client.query(
      `INSERT INTO messages (conversation_id, sender_id, body)
       VALUES ($1, $2, $3) RETURNING *`,
      [conversationId, senderId, body]
    );
    return { message: rows[0] };
  });
  if (result.blocked) {
    throw new ValidationError('Messages cannot contain phone numbers, email addresses, or links.');
  }
  eventBus.emit(events.MESSAGE_SENT, { conversationId, senderId });
  return result.message;
}

// ---- FR-29, FR-31: negotiation (offer / counter / accept) ----

/** FR-29: no fixed Buy Now path — this is the only way a sale starts. */
async function makeOffer(conversationId, listingId, buyerId, amount) {
  assertOffersEnabled();
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
  assertOffersEnabled();
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
  assertOffersEnabled();
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
async function getNegotiationHistory(listingId, userId) {
  const { rows: conversations } = await db.query(
    `SELECT id FROM conversations
     WHERE listing_id = $1 AND (buyer_id = $2 OR seller_id = $2)`,
    [listingId, userId]
  );
  if (!conversations[0]) throw new NotFoundError('conversation', listingId);
  const conversationIds = conversations.map(({ id }) => id);
  const { rows: offers } = await db.query(
    'SELECT * FROM offers WHERE conversation_id = ANY($1::uuid[]) ORDER BY created_at ASC',
    [conversationIds]
  );
  const { rows: messages } = await db.query(
    'SELECT * FROM messages WHERE conversation_id = ANY($1::uuid[]) ORDER BY created_at ASC',
    [conversationIds]
  );
  return { offers, messages };
}

module.exports = {
  startConversation,
  sendMessage,
  containsContactInfo,
  makeOffer,
  counterOffer,
  acceptOffer,
  getNegotiationHistory,
};
