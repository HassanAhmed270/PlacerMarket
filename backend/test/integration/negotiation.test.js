const { randomUUID } = require('node:crypto');
const db = require('../../src/db.service');
const negotiation = require('../../src/modules/negotiation.service');

describe('PostgreSQL messaging rules', () => {
  const ids = {
    seller: randomUUID(),
    buyer: randomUUID(),
    other: randomUUID(),
    mainCategory: randomUUID(),
    subCategory: randomUUID(),
    listing: randomUUID(),
  };
  let conversation;

  beforeAll(async () => {
    const suffix = randomUUID();
    await db.query(
      `INSERT INTO users (id, phone, email, password_hash, full_name, role)
       VALUES ($1, $2, $3, 'integration-test-hash', 'Messaging Seller', 'seller'),
              ($4, $5, $6, 'integration-test-hash', 'Messaging Buyer', 'buyer'),
              ($7, $8, $9, 'integration-test-hash', 'Messaging Other', 'buyer')`,
      [
        ids.seller, `+92300${suffix.slice(0, 7)}`, `seller-${suffix}@example.test`,
        ids.buyer, `+92301${suffix.slice(0, 7)}`, `buyer-${suffix}@example.test`,
        ids.other, `+92302${suffix.slice(0, 7)}`, `other-${suffix}@example.test`,
      ]
    );
    await db.query('INSERT INTO main_categories (id, name) VALUES ($1, $2)', [ids.mainCategory, `Messaging ${suffix}`]);
    await db.query('INSERT INTO sub_categories (id, main_category_id, name) VALUES ($1, $2, $3)', [
      ids.subCategory, ids.mainCategory, `Messaging ${suffix}`,
    ]);
    await db.query(
      `INSERT INTO listings (id, seller_id, main_category_id, sub_category_id, condition, title, asking_price, status)
       VALUES ($1, $2, $3, $4, 'brand_new', 'Integration message listing', 85000, 'published')`,
      [ids.listing, ids.seller, ids.mainCategory, ids.subCategory]
    );
    conversation = await negotiation.startConversation(ids.listing, ids.buyer);
  });

  beforeEach(async () => {
    await db.query("UPDATE listings SET status = 'published' WHERE id = $1", [ids.listing]);
    await db.query('DELETE FROM messages WHERE conversation_id = $1', [conversation.id]);
    await db.query('DELETE FROM contact_info_block_attempts WHERE user_id = $1', [ids.buyer]);
  });

  afterAll(async () => {
    await db.query('DELETE FROM contact_info_block_attempts WHERE user_id = ANY($1::uuid[])', [[ids.buyer, ids.seller, ids.other]]);
    await db.query('DELETE FROM messages WHERE conversation_id = $1', [conversation.id]);
    await db.query('DELETE FROM conversations WHERE id = $1', [conversation.id]);
    await db.query('DELETE FROM listings WHERE id = $1', [ids.listing]);
    await db.query('DELETE FROM sub_categories WHERE id = $1', [ids.subCategory]);
    await db.query('DELETE FROM main_categories WHERE id = $1', [ids.mainCategory]);
    await db.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[ids.seller, ids.buyer, ids.other]]);
  });

  test('allows prices and measurements and blocks contact content without storing it', async () => {
    for (const body of ['PKR 85,000', '85000', 'chest 40 length 42']) {
      await expect(negotiation.sendMessage(conversation.id, ids.buyer, body)).resolves.toMatchObject({ body });
    }
    for (const body of ['0300 1234567', '0300-1234567', 'buyer@example.test', 'https://example.test']) {
      await expect(negotiation.sendMessage(conversation.id, ids.buyer, body))
        .rejects.toThrow('Messages cannot contain phone numbers, email addresses, or links.');
    }
    const { rows: messages } = await db.query('SELECT body FROM messages WHERE conversation_id = $1', [conversation.id]);
    expect(messages.map(({ body }) => body)).toEqual(['PKR 85,000', '85000', 'chest 40 length 42']);
    const { rows: attempts } = await db.query(
      'SELECT attempt_count::int AS attempt_count FROM contact_info_block_attempts WHERE user_id = $1',
      [ids.buyer]
    );
    expect(attempts[0].attempt_count).toBe(4);
  });

  test('allows only participants to read history or send messages', async () => {
    await expect(negotiation.sendMessage(conversation.id, ids.other, 'Hello'))
      .rejects.toThrow('conversation not found');
    await expect(negotiation.getNegotiationHistory(ids.listing, ids.other))
      .rejects.toThrow('conversation not found');
    await expect(negotiation.getNegotiationHistory(ids.listing, ids.buyer))
      .resolves.toMatchObject({ offers: [], messages: [] });
  });

  test('makes conversations read-only when a listing is sold or removed', async () => {
    for (const status of ['sold', 'removed']) {
      await db.query('UPDATE listings SET status = $1 WHERE id = $2', [status, ids.listing]);
      await expect(negotiation.sendMessage(conversation.id, ids.buyer, 'Is this available?'))
        .rejects.toThrow('This conversation is read-only');
      const { rows } = await db.query('SELECT count(*)::int AS count FROM messages WHERE conversation_id = $1', [conversation.id]);
      expect(rows[0].count).toBe(0);
    }
  });
});
