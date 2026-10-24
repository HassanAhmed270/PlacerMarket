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
    await eventBus.emitAsync(events.MESSAGE_SENT, {
      conversationId,
      senderId,
      messageId: rows[0].id,
    }, { transaction: client });
    return { message: rows[0] };
  });
  if (result.blocked) {
    throw new ValidationError('Messages cannot contain phone numbers, email addresses, or links.');
  }
  return result.message;
}

/** FR-28: return a participant's conversations with keyset pagination and unread counts. */
async function getInbox(userId, { limit = 20, beforeActivityAt, beforeId } = {}) {
  const values = [userId];
  let cursorClause = '';
  if (beforeActivityAt && beforeId) {
    values.push(beforeActivityAt, beforeId);
    cursorClause = `AND (COALESCE(last_message.created_at, c.created_at), c.id) < ($2::timestamptz, $3::uuid)`;
  }
  values.push(limit + 1);
  const limitIndex = values.length;
  const { rows } = await db.query(
    `SELECT c.id, c.listing_id, c.buyer_id, c.seller_id, c.created_at,
            to_char(
              COALESCE(last_message.created_at, c.created_at) AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS last_activity_at,
            last_message.id AS last_message_id, last_message.sender_id AS last_sender_id,
            last_message.body AS last_message_body,
            COUNT(unread.id)::int AS unread_count
     FROM conversations c
     LEFT JOIN LATERAL (
       SELECT m.id, m.sender_id, m.body, m.created_at
       FROM messages m
       WHERE m.conversation_id = c.id
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT 1
     ) last_message ON true
     LEFT JOIN messages unread
       ON unread.conversation_id = c.id
      AND unread.sender_id <> $1
      AND unread.read_at IS NULL
     WHERE (c.buyer_id = $1 OR c.seller_id = $1)
       ${cursorClause}
     GROUP BY c.id, last_message.id, last_message.sender_id, last_message.body, last_message.created_at
     ORDER BY COALESCE(last_message.created_at, c.created_at) DESC, c.id DESC
     LIMIT $${limitIndex}`,
    values
  );
  const hasMore = rows.length > limit;
  const conversations = hasMore ? rows.slice(0, limit) : rows;
  const last = conversations[conversations.length - 1];
  return {
    conversations,
    nextCursor: hasMore && last
      ? { beforeActivityAt: last.last_activity_at, beforeId: last.id }
      : null,
  };
}

/** FR-28: read messages only after confirming the caller is a conversation participant. */
async function getConversationMessages(conversationId, userId, { limit = 50, beforeCreatedAt, beforeId } = {}) {
  const { rows: conversations } = await db.query(
    'SELECT id FROM conversations WHERE id = $1 AND (buyer_id = $2 OR seller_id = $2)',
    [conversationId, userId]
  );
  if (!conversations[0]) throw new NotFoundError('conversation', conversationId);

  const values = [conversationId, userId];
  let cursorClause = '';
  if (beforeCreatedAt && beforeId) {
    values.push(beforeCreatedAt, beforeId);
    cursorClause = `AND (m.created_at, m.id) < ($3::timestamptz, $4::uuid)`;
  }
  values.push(limit + 1);
  const limitIndex = values.length;
  const { rows } = await db.query(
    `SELECT m.*,
            to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
     FROM conversations c
     JOIN messages m ON m.conversation_id = c.id
     WHERE c.id = $1
       AND (c.buyer_id = $2 OR c.seller_id = $2)
       ${cursorClause}
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT $${limitIndex}`,
    values
  );
  const hasMore = rows.length > limit;
  const messages = hasMore ? rows.slice(0, limit) : rows;
  const last = messages[messages.length - 1];
  return {
    messages,
    nextCursor: hasMore && last
      ? { beforeCreatedAt: last.cursor_created_at, beforeId: last.id }
      : null,
  };
}

/** FR-28: only the conversation participant can mark messages received by them as read. */
async function markConversationRead(conversationId, userId) {
  return db.withTransaction(async (client) => {
    const { rows: conversations } = await client.query(
      'SELECT id FROM conversations WHERE id = $1 AND (buyer_id = $2 OR seller_id = $2) FOR SHARE',
      [conversationId, userId]
    );
    if (!conversations[0]) throw new NotFoundError('conversation', conversationId);
    const { rowCount } = await client.query(
      `UPDATE messages SET read_at = now()
       WHERE conversation_id = $1 AND sender_id <> $2 AND read_at IS NULL`,
      [conversationId, userId]
    );
    return { markedRead: rowCount };
  });
}

/** FR-28: confirm participant access before conversation-scoped route middleware continues. */
async function assertConversationParticipant(conversationId, userId) {
  const { rows } = await db.query(
    'SELECT id FROM conversations WHERE id = $1 AND (buyer_id = $2 OR seller_id = $2)',
    [conversationId, userId]
  );
  if (!rows[0]) throw new NotFoundError('conversation', conversationId);
}

/** FR-29: confirm offer access before offer-scoped route middleware continues. */
async function assertOfferParticipant(offerId, userId) {
  const { rows } = await db.query(
    `SELECT o.id FROM offers o JOIN conversations c ON c.id = o.conversation_id
     WHERE o.id = $1 AND (c.buyer_id = $2 OR c.seller_id = $2)`,
    [offerId, userId]
  );
  if (!rows[0]) throw new NotFoundError('offer', offerId);
}

/** FR-28, SEC-12: staff reads require a reference and are recorded in the same transaction as the read. */
async function getStaffConversationMessages(conversationId, staffUserId, { referenceType, referenceId, limit = 50 } = {}) {
  if (!['dispute', 'report'].includes(referenceType) ||
      typeof referenceId !== 'string' || !referenceId.trim() || referenceId.length > 100) {
    throw new ValidationError('A dispute or report reference is required.');
  }
  return db.withTransaction(async (client) => {
    const { rows: conversations } = await client.query(
      'SELECT id, listing_id, buyer_id, seller_id FROM conversations WHERE id = $1 FOR SHARE',
      [conversationId]
    );
    if (!conversations[0]) throw new NotFoundError('conversation', conversationId);

    if (referenceType === 'dispute') {
      const { rows: disputes } = await client.query(
        `SELECT d.id FROM disputes d
         JOIN orders o ON o.id = d.order_id
         WHERE d.id::text = $1
           AND o.listing_id = $2
           AND o.buyer_id = $3
           AND o.seller_id = $4`,
        [
          referenceId,
          conversations[0].listing_id,
          conversations[0].buyer_id,
          conversations[0].seller_id,
        ]
      );
      if (!disputes[0]) throw new NotFoundError('dispute reference', referenceId);
    }

    await client.query(
      `INSERT INTO conversation_staff_read_audit
        (conversation_id, staff_user_id, reference_type, reference_id)
       VALUES ($1, $2, $3, $4)`,
      [conversationId, staffUserId, referenceType, referenceId.trim()]
    );
    const { rows: messages } = await client.query(
      `SELECT * FROM messages WHERE conversation_id = $1
       ORDER BY created_at DESC, id DESC LIMIT $2`,
      [conversationId, limit]
    );
    return messages;
  });
}

// ---- FR-29, FR-31: negotiation (offer / counter / accept) ----

/** FR-29: no fixed Buy Now path — this is the only way a sale starts. */
async function makeOffer(conversationId, listingId, buyerId, amount) {
  return db.withTransaction(async (client) => {
    const { rows: conversations } = await client.query(
      `SELECT id FROM conversations
       WHERE id = $1 AND listing_id = $2 AND (buyer_id = $3 OR seller_id = $3)
       FOR SHARE`,
      [conversationId, listingId, buyerId]
    );
    if (!conversations[0]) throw new NotFoundError('conversation', conversationId);
    assertOffersEnabled();
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
  const counter = await db.withTransaction(async (client) => {
    const { rows: parentRows } = await client.query(
      `SELECT o.* FROM offers o JOIN conversations c ON c.id = o.conversation_id
       WHERE o.id = $1 AND (c.buyer_id = $2 OR c.seller_id = $2)
       FOR UPDATE OF o, c`,
      [parentOfferId, proposedBy]
    );
    const parent = parentRows[0];
    if (!parent) throw new NotFoundError('offer', parentOfferId);
    assertOffersEnabled();
    if (parent.status !== 'pending') throw new ValidationError('Only a pending offer can be countered');
    await client.query(`UPDATE offers SET status = 'countered' WHERE id = $1`, [parentOfferId]);
    const { rows } = await client.query(
      `INSERT INTO offers (conversation_id, listing_id, proposed_by, amount, status, parent_offer_id)
       VALUES ($1, $2, $3, $4, 'pending', $5) RETURNING *`,
      [parent.conversation_id, parent.listing_id, proposedBy, amount, parentOfferId]
    );
    return rows[0];
  });
  eventBus.emit(events.OFFER_COUNTERED, { offerId: counter.id, parentOfferId });
  return counter;
}

/**
 * FR-29: accepting an offer is the only path to a sale. Hands off to
 * orders.service.js to create the Bag entry (FR-32) — this file does not
 * touch the `orders` table directly.
 */
async function acceptOffer(offerId, acceptedBy) {
  const { rows: participantOffers } = await db.query(
    `SELECT o.id FROM offers o JOIN conversations c ON c.id = o.conversation_id
     WHERE o.id = $1 AND (c.buyer_id = $2 OR c.seller_id = $2)`,
    [offerId, acceptedBy]
  );
  if (!participantOffers[0]) throw new NotFoundError('offer', offerId);
  assertOffersEnabled();
  const { rows } = await db.query(
    `UPDATE offers o SET status = 'accepted'
     WHERE o.id = $1 AND o.status = 'pending'
       AND EXISTS (
         SELECT 1 FROM conversations c
         WHERE c.id = o.conversation_id AND (c.buyer_id = $2 OR c.seller_id = $2)
       )
     RETURNING o.*`,
    [offerId, acceptedBy]
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
  getInbox,
  getConversationMessages,
  markConversationRead,
  assertConversationParticipant,
  assertOfferParticipant,
  getStaffConversationMessages,
  containsContactInfo,
  makeOffer,
  counterOffer,
  acceptOffer,
  getNegotiationHistory,
};
