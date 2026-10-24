const express = require('express');
const request = require('supertest');

jest.mock('../../src/modules/negotiation.service', () => ({
  startConversation: jest.fn(),
  sendMessage: jest.fn(),
  makeOffer: jest.fn(),
  counterOffer: jest.fn(),
  acceptOffer: jest.fn(),
  getNegotiationHistory: jest.fn(),
}));
jest.mock('../../src/middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = { id: '11111111-1111-4111-8111-111111111111' }; next(); },
}));
jest.mock('../../src/middleware/rateLimit', () => ({
  createConfiguredRateLimiters: () => ({
    conversation: (_req, _res, next) => next(),
    message: (_req, _res, next) => next(),
    offer: (_req, _res, next) => next(),
  }),
}));

const negotiation = require('../../src/modules/negotiation.service');
const router = require('../../src/routes/negotiation.routes');
const app = express();
app.use(express.json());
app.use('/negotiation', router);
app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.message }));

const listingId = '33333333-3333-4333-8333-333333333333';
const conversationId = '44444444-4444-4444-8444-444444444444';

describe('negotiation route validation', () => {
  beforeEach(() => jest.clearAllMocks());

  test('uses the authenticated buyer and does not accept a seller from the request body', async () => {
    negotiation.startConversation.mockResolvedValue({ id: conversationId });
    const response = await request(app).post('/negotiation/conversations')
      .send({ listingId, sellerId: '55555555-5555-4555-8555-555555555555' });
    expect(response.status).toBe(201);
    expect(negotiation.startConversation).toHaveBeenCalledWith(listingId, '11111111-1111-4111-8111-111111111111');
  });

  test('rejects malformed UUIDs and message lengths before calling the service', async () => {
    const malformed = await request(app).post('/negotiation/conversations').send({ listingId: 'not-a-uuid' });
    const tooLong = await request(app).post(`/negotiation/conversations/${conversationId}/messages`)
      .send({ body: 'x'.repeat(1001) });
    const malformedConversation = await request(app).post('/negotiation/conversations/not-a-uuid/messages')
      .send({ body: 'Hello' });
    expect([malformed.status, tooLong.status, malformedConversation.status]).toEqual([400, 400, 400]);
    expect(negotiation.startConversation).not.toHaveBeenCalled();
    expect(negotiation.sendMessage).not.toHaveBeenCalled();
  });

  test('accepts a message of exactly 1000 characters', async () => {
    const body = '🙂'.repeat(1000);
    negotiation.sendMessage.mockResolvedValue({ id: 'message-1', body });
    const response = await request(app).post(`/negotiation/conversations/${conversationId}/messages`).send({ body });
    expect(response.status).toBe(201);
    expect(negotiation.sendMessage).toHaveBeenCalledWith(conversationId, '11111111-1111-4111-8111-111111111111', body);
  });
});
