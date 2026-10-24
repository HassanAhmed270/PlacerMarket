const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');

jest.mock('../../src/middleware/auth', () => {
  const actual = jest.requireActual('../../src/middleware/auth');
  return {
    ...actual,
    requireAuth: (req, _res, next) => {
      req.user = {
        id: req.get('x-test-user-id'),
        role: req.get('x-test-role') || 'buyer',
      };
      next();
    },
  };
});

jest.mock('../../src/middleware/rateLimit', () => ({
  createConfiguredRateLimiters: () => ({
    conversation: (_req, _res, next) => next(),
    message: (_req, _res, next) => next(),
    offer: (_req, _res, next) => next(),
  }),
}));

const db = require('../../src/db.service');
const queue = require('../../src/lib/queue');
const negotiation = require('../../src/modules/negotiation.service');
const notifications = require('../../src/modules/notifications.service');
const negotiationRoutes = require('../../src/routes/negotiation.routes');
const notificationRoutes = require('../../src/routes/notifications.routes');
const errorHandler = require('../../src/middleware/errorHandler');

const app = express();
app.use(express.json());
app.use('/negotiation', negotiationRoutes);
app.use('/notifications', notificationRoutes);
app.use(errorHandler);

describe('SEC-12 PostgreSQL conversation access, audit, and notifications', () => {
  const ids = {
    seller: randomUUID(),
    buyer: randomUUID(),
    stranger: randomUUID(),
    category: randomUUID(),
    subCategory: randomUUID(),
    listing: randomUUID(),
    secondListing: randomUUID(),
  };
  let conversation;
  let secondConversation;
  let offerId;
  let notificationId;
  let oldOffersEnabled;
  let oldEmailKey;

  beforeAll(async () => {
    const suffix = randomUUID();
    await db.query(
      `INSERT INTO users (id, phone, email, password_hash, full_name, role)
       VALUES ($1, $2, $3, 'integration-test-hash', 'SEC-12 Seller', 'seller'),
              ($4, $5, $6, 'integration-test-hash', 'SEC-12 Buyer', 'buyer'),
              ($7, $8, $9, 'integration-test-hash', 'SEC-12 Stranger', 'buyer')`,
      [
        ids.seller, `+92300${suffix.slice(0, 7)}`, `seller-${suffix}@example.test`,
        ids.buyer, `+92301${suffix.slice(0, 7)}`, `buyer-${suffix}@example.test`,
        ids.stranger, `+92302${suffix.slice(0, 7)}`, `stranger-${suffix}@example.test`,
      ]
    );
    await db.query('INSERT INTO main_categories (id, name) VALUES ($1, $2)', [ids.category, `SEC-12 ${suffix}`]);
    await db.query('INSERT INTO sub_categories (id, main_category_id, name) VALUES ($1, $2, $3)', [
      ids.subCategory, ids.category, `SEC-12 ${suffix}`,
    ]);
    await db.query(
      `INSERT INTO listings (id, seller_id, main_category_id, sub_category_id, condition, title, asking_price, status)
       VALUES ($1, $2, $3, $4, 'brand_new', 'SEC-12 conversation', 85000, 'published'),
              ($5, $2, $3, $4, 'brand_new', 'SEC-12 second conversation', 85000, 'published')`,
      [ids.listing, ids.seller, ids.category, ids.subCategory, ids.secondListing]
    );
    conversation = await negotiation.startConversation(ids.listing, ids.buyer);
    secondConversation = await negotiation.startConversation(ids.secondListing, ids.buyer);
    const { rows: offerRows } = await db.query(
      `INSERT INTO offers (conversation_id, listing_id, proposed_by, amount, status)
       VALUES ($1, $2, $3, 80000, 'pending') RETURNING id`,
      [conversation.id, ids.listing, ids.buyer]
    );
    offerId = offerRows[0].id;
    const { rows: notificationRows } = await db.query(
      `INSERT INTO notifications (user_id, event_type, payload)
       VALUES ($1, 'fixture', '{}'::jsonb) RETURNING id`,
      [ids.buyer]
    );
    notificationId = notificationRows[0].id;
    oldOffersEnabled = process.env.OFFERS_ENABLED;
    process.env.OFFERS_ENABLED = '1';
    oldEmailKey = process.env.EMAIL_QUEUE_ENCRYPTION_SECRET;
    process.env.EMAIL_QUEUE_ENCRYPTION_SECRET = 'integration-email-queue-key-material-over-32-bytes';
  });

  afterAll(async () => {
    if (oldOffersEnabled === undefined) delete process.env.OFFERS_ENABLED;
    else process.env.OFFERS_ENABLED = oldOffersEnabled;
    if (oldEmailKey === undefined) delete process.env.EMAIL_QUEUE_ENCRYPTION_SECRET;
    else process.env.EMAIL_QUEUE_ENCRYPTION_SECRET = oldEmailKey;
    await db.query('DELETE FROM conversation_email_throttles WHERE conversation_id = ANY($1::uuid[])',
      [[conversation.id, secondConversation.id]]);
    await db.query('DELETE FROM conversation_staff_read_audit WHERE conversation_id = $1', [conversation.id]);
    await db.query('DELETE FROM notifications WHERE user_id = ANY($1::uuid[])',
      [[ids.seller, ids.buyer, ids.stranger]]);
    await db.query('DELETE FROM messages WHERE conversation_id = ANY($1::uuid[])',
      [[conversation.id, secondConversation.id]]);
    await db.query('DELETE FROM offers WHERE conversation_id = $1', [conversation.id]);
    await db.query('DELETE FROM conversations WHERE id = ANY($1::uuid[])',
      [[conversation.id, secondConversation.id]]);
    await db.query('DELETE FROM listings WHERE id = ANY($1::uuid[])',
      [[ids.listing, ids.secondListing]]);
    await db.query('DELETE FROM sub_categories WHERE id = $1', [ids.subCategory]);
    await db.query('DELETE FROM main_categories WHERE id = $1', [ids.category]);
    await db.query('DELETE FROM users WHERE id = ANY($1::uuid[])',
      [[ids.seller, ids.buyer, ids.stranger]]);
  });

  test('SEC-12: every conversation/message ID route denies a stranger', async () => {
    const stranger = { 'x-test-user-id': ids.stranger };
    const responses = await Promise.all([
      request(app).get(`/negotiation/conversations/${conversation.id}/messages`).set(stranger),
      request(app).post(`/negotiation/conversations/${conversation.id}/messages`).set(stranger).send({ body: 'hello' }),
      request(app).patch(`/negotiation/conversations/${conversation.id}/read`).set(stranger),
      request(app).post(`/negotiation/conversations/${conversation.id}/offers`).set(stranger)
        .send({ listingId: ids.listing, amount: 80000 }),
      request(app).post(`/negotiation/offers/${offerId}/counter`).set(stranger).send({ amount: 81000 }),
      request(app).post(`/negotiation/offers/${offerId}/accept`).set(stranger),
      request(app).get(`/negotiation/listings/${ids.listing}/history`).set(stranger),
      request(app).patch(`/notifications/${notificationId}/read`).set(stranger),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([404, 404, 404, 404, 404, 404, 404, 404]);
    const previousFlag = process.env.OFFERS_ENABLED;
    process.env.OFFERS_ENABLED = '0';
    try {
      const disabledOfferResponses = await Promise.all([
        request(app).post(`/negotiation/conversations/${conversation.id}/offers`).set(stranger)
          .send({ listingId: ids.listing, amount: 80000 }),
        request(app).post(`/negotiation/offers/${offerId}/counter`).set(stranger).send({ amount: 81000 }),
        request(app).post(`/negotiation/offers/${offerId}/accept`).set(stranger),
      ]);
      expect(disabledOfferResponses.map(({ status }) => status)).toEqual([404, 404, 404]);
    } finally {
      process.env.OFFERS_ENABLED = previousFlag;
    }

    const { rows: notificationRows } = await db.query(
      'SELECT is_read FROM notifications WHERE id = $1', [notificationId]
    );
    expect(notificationRows[0].is_read).toBe(false);
    const ownerRead = await request(app).patch(`/notifications/${notificationId}/read`)
      .set({ 'x-test-user-id': ids.buyer });
    expect(ownerRead.status).toBe(204);
    const { rows: ownerRows } = await db.query('SELECT is_read FROM notifications WHERE id = $1', [notificationId]);
    expect(ownerRows[0].is_read).toBe(true);
  });

  test('SEC-12: inbox and message keyset pages are participant-scoped and report unread counts', async () => {
    await db.query(
      `INSERT INTO messages (conversation_id, sender_id, body)
       VALUES ($1, $2, 'seller unread 1'), ($1, $2, 'seller unread 2'),
              ($1, $3, 'buyer reply'), ($4, $2, 'second listing')`,
      [conversation.id, ids.seller, ids.buyer, secondConversation.id]
    );

    const inboxPage = await request(app).get('/negotiation/conversations')
      .set({ 'x-test-user-id': ids.buyer }).query({ limit: 1 });
    expect(inboxPage.status).toBe(200);
    expect(inboxPage.body.conversations).toHaveLength(1);
    expect(inboxPage.body.nextCursor).toEqual(expect.objectContaining({
      beforeActivityAt: expect.any(String), beforeId: expect.any(String),
    }));

    const nextPage = await request(app).get('/negotiation/conversations')
      .set({ 'x-test-user-id': ids.buyer })
      .query({ limit: 1, ...inboxPage.body.nextCursor });
    expect(nextPage.status).toBe(200);
    expect(nextPage.body.conversations).toHaveLength(1);
    expect(nextPage.body.conversations[0].id).not.toBe(inboxPage.body.conversations[0].id);

    const allInbox = await negotiation.getInbox(ids.buyer, { limit: 10 });
    expect(allInbox.conversations.find(({ id }) => id === conversation.id).unread_count).toBe(2);

    const messagesPage = await request(app).get(`/negotiation/conversations/${conversation.id}/messages`)
      .set({ 'x-test-user-id': ids.buyer }).query({ limit: 2 });
    expect(messagesPage.status).toBe(200);
    expect(messagesPage.body.messages).toHaveLength(2);
    expect(messagesPage.body.nextCursor).toEqual(expect.objectContaining({
      beforeCreatedAt: expect.any(String), beforeId: expect.any(String),
    }));
    const nextMessagesPage = await request(app).get(`/negotiation/conversations/${conversation.id}/messages`)
      .set({ 'x-test-user-id': ids.buyer })
      .query({ limit: 2, ...messagesPage.body.nextCursor });
    expect(nextMessagesPage.status).toBe(200);
    expect(nextMessagesPage.body.messages.every(({ id }) =>
      !messagesPage.body.messages.some((message) => message.id === id))).toBe(true);

    const marked = await request(app).patch(`/negotiation/conversations/${conversation.id}/read`)
      .set({ 'x-test-user-id': ids.buyer });
    expect(marked.status).toBe(200);
    expect(marked.body.markedRead).toBe(2);
    const inboxAfterRead = await negotiation.getInbox(ids.buyer, { limit: 10 });
    expect(inboxAfterRead.conversations.find(({ id }) => id === conversation.id).unread_count).toBe(0);
  });

  test('SEC-12: staff conversation reads require the new permission and an audited reference', async () => {
    const denied = await request(app).get(`/negotiation/conversations/${conversation.id}/staff/messages`)
      .set({ 'x-test-user-id': ids.stranger }).query({ referenceType: 'report', referenceId: 'RPT-1' });
    expect(denied.status).toBe(403);

    const invalidDispute = await request(app).get(`/negotiation/conversations/${conversation.id}/staff/messages`)
      .set({ 'x-test-user-id': ids.stranger, 'x-test-role': 'moderator' })
      .query({ referenceType: 'dispute', referenceId: randomUUID() });
    expect(invalidDispute.status).toBe(404);

    for (const referenceId of ['RPT-1', 'RPT-2']) {
      const response = await request(app).get(`/negotiation/conversations/${conversation.id}/staff/messages`)
        .set({ 'x-test-user-id': ids.stranger, 'x-test-role': 'moderator' })
        .query({ referenceType: 'report', referenceId });
      expect(response.status).toBe(200);
    }
    const { rows } = await db.query(
      `SELECT staff_user_id, reference_type, reference_id, count(*) OVER ()::int AS reads
       FROM conversation_staff_read_audit WHERE conversation_id = $1 ORDER BY read_at`,
      [conversation.id]
    );
    expect(rows).toHaveLength(2);
    expect(rows.map(({ reference_id: referenceId }) => referenceId)).toEqual(['RPT-1', 'RPT-2']);
    expect(rows.every(({ staff_user_id: staffId, reference_type: type, reads }) =>
      staffId === ids.stranger && type === 'report' && reads === 2)).toBe(true);
  });

  test('SEC-12: notification and email work are duplicate-safe and email is throttled per conversation', async () => {
    const { rows: firstMessage } = await db.query(
      `INSERT INTO messages (conversation_id, sender_id, body, created_at)
       VALUES ($1, $2, 'private message body', now() - interval '16 minutes') RETURNING id`,
      [conversation.id, ids.buyer]
    );
    const messageId = firstMessage[0].id;
    const processJob = (job) => db.withTransaction((client) => notifications.processNotificationJob(job, {
      executeSql: (text, values) => client.query(text, values),
    }));
    const messageNotification = {
      eventName: 'message.sent',
      payload: { conversationId: conversation.id, messageId },
    };

    await processJob(messageNotification);
    await processJob(messageNotification);
    const { rows: notificationRows } = await db.query(
      `SELECT count(*)::int AS count FROM notifications
       WHERE user_id = $1 AND dedupe_key = $2`,
      [ids.seller, `message:${messageId}`]
    );
    expect(notificationRows[0].count).toBe(1);

    const emailCheck = {
      eventName: 'conversation.message_email_check',
      payload: { conversationId: conversation.id, messageId },
    };
    await processJob(emailCheck);
    await processJob(emailCheck);
    const { rows: throttleRows } = await db.query(
      `SELECT last_message_id FROM conversation_email_throttles WHERE conversation_id = $1`,
      [conversation.id]
    );
    expect(throttleRows).toEqual([{ last_message_id: messageId }]);

    const { rows: secondMessage } = await db.query(
      `INSERT INTO messages (conversation_id, sender_id, body, created_at)
       VALUES ($1, $2, 'another private message', now() - interval '16 minutes') RETURNING id`,
      [conversation.id, ids.buyer]
    );
    await processJob({
      eventName: 'conversation.message_email_check',
      payload: { conversationId: conversation.id, messageId: secondMessage[0].id },
    });
    const { rows: throttleAfterSecond } = await db.query(
      `SELECT last_message_id FROM conversation_email_throttles WHERE conversation_id = $1`,
      [conversation.id]
    );
    expect(throttleAfterSecond[0].last_message_id).toBe(messageId);

    await db.query(
      `UPDATE conversation_email_throttles
       SET last_queued_at = now() - interval '1 hour 1 second'
       WHERE conversation_id = $1`,
      [conversation.id]
    );
    await processJob({
      eventName: 'conversation.message_email_check',
      payload: { conversationId: conversation.id, messageId: secondMessage[0].id },
    });
    const { rows: throttleAfterWindow } = await db.query(
      'SELECT last_message_id FROM conversation_email_throttles WHERE conversation_id = $1',
      [conversation.id]
    );
    expect(throttleAfterWindow[0].last_message_id).toBe(secondMessage[0].id);
  });
});
