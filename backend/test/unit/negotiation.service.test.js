jest.mock('../../src/db.service', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(),
}));

const db = require('../../src/db.service');
const negotiation = require('../../src/modules/negotiation.service');

const buyerId = '11111111-1111-4111-8111-111111111111';
const sellerId = '22222222-2222-4222-8222-222222222222';
const listingId = '33333333-3333-4333-8333-333333333333';
const conversationId = '44444444-4444-4444-8444-444444444444';

function transactionClient(status = 'published') {
  const queries = [];
  const client = {
    queries,
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes('FROM listings WHERE id')) {
        return { rows: [{ id: listingId, seller_id: sellerId, status }] };
      }
      if (String(sql).includes('FROM conversations c')) {
        return { rows: [{ id: conversationId, listing_id: listingId, status }] };
      }
      if (String(sql).includes('INSERT INTO conversations')) {
        return { rows: [{ id: conversationId, listing_id: listingId, buyer_id: buyerId, seller_id: params[2] }] };
      }
      if (String(sql).includes('INSERT INTO messages')) {
        return { rows: [{ id: 'message-1', body: params[2] }] };
      }
      return { rows: [] };
    },
  };
  db.withTransaction.mockImplementation((callback) => callback(client));
  return client;
}

describe('messaging service rules', () => {
  beforeEach(() => jest.clearAllMocks());

  test('opens conversations only for published listings and derives the seller', async () => {
    const client = transactionClient();
    const conversation = await negotiation.startConversation(listingId, buyerId);
    expect(conversation.seller_id).toBe(sellerId);
    expect(client.queries[1].params).toEqual([listingId, buyerId, sellerId]);

    transactionClient('paused');
    await expect(negotiation.startConversation(listingId, buyerId))
      .rejects.toThrow('Conversations can only be started for published listings.');
    transactionClient();
    await expect(negotiation.startConversation(listingId, sellerId))
      .rejects.toThrow('You cannot start a conversation with yourself.');
  });

  test('accepts prices and measurements while blocking phone, email, and link contact details', async () => {
    for (const message of ['PKR 85,000', '85000', 'chest 40 length 42']) {
      transactionClient();
      await expect(negotiation.sendMessage(conversationId, buyerId, message))
        .resolves.toMatchObject({ body: message });
    }

    for (const message of [
      '0300 1234567',
      '0300-1234567',
      'Contact buyer@example.com',
      'Visit https://example.com',
      'Visit www.example.com',
      'Visit example.test',
    ]) {
      const client = transactionClient();
      await expect(negotiation.sendMessage(conversationId, buyerId, message))
        .rejects.toThrow('Messages cannot contain phone numbers, email addresses, or links.');
      expect(client.queries.some(({ sql }) => sql.includes('INSERT INTO messages'))).toBe(false);
      const attempt = client.queries.find(({ sql }) => sql.includes('contact_info_block_attempts'));
      expect(attempt.params).toEqual([buyerId]);
      expect(JSON.stringify(attempt.params)).not.toContain(message);
    }
  });

  test('rejects overlong messages and prevents writes after a listing is sold or removed', async () => {
    await expect(negotiation.sendMessage(conversationId, buyerId, 'x'.repeat(1001)))
      .rejects.toThrow('Message must contain 1 to 1000 characters.');

    for (const status of ['sold', 'removed']) {
      const client = transactionClient(status);
      await expect(negotiation.sendMessage(conversationId, buyerId, 'Is this available?'))
        .rejects.toThrow('This conversation is read-only');
      expect(client.queries.some(({ sql }) => sql.includes('INSERT INTO messages'))).toBe(false);
    }
  });

  test('limits negotiation history to the conversation participants', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(negotiation.getNegotiationHistory(listingId, '55555555-5555-4555-8555-555555555555'))
      .rejects.toThrow('conversation not found');
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
