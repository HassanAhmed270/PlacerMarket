jest.mock('../../src/db.service', () => ({
  withTransaction: jest.fn(),
}));
jest.mock('../../src/modules/orders.service', () => ({
  lockReviewOrder: jest.fn(),
}));
jest.mock('../../src/modules/disputes.service', () => ({
  hasOpenDisputeInTransaction: jest.fn(),
}));
jest.mock('../../src/modules/returnRequests.service', () => ({
  hasOpenReturnRequest: jest.fn(),
}));
jest.mock('../../src/modules/chargebacks.service', () => ({
  hasOpenPayoutIssue: jest.fn(),
}));
jest.mock('../../src/modules/settlement.service', () => ({
  getSettingsForTransaction: jest.fn(),
}));
jest.mock('../../src/modules/sellerPayouts.service', () => ({
  getBusinessDate: jest.fn(),
}));
jest.mock('../../src/lib/eventBus', () => ({
  emitAsync: jest.fn(),
}));

const db = require('../../src/db.service');
const orders = require('../../src/modules/orders.service');
const disputes = require('../../src/modules/disputes.service');
const returnRequests = require('../../src/modules/returnRequests.service');
const chargebacks = require('../../src/modules/chargebacks.service');
const settlement = require('../../src/modules/settlement.service');
const sellerPayouts = require('../../src/modules/sellerPayouts.service');
const eventBus = require('../../src/lib/eventBus');
const reviews = require('../../src/modules/reviews.service');

const orderId = '11111111-1111-4111-8111-111111111111';
const buyerId = '22222222-2222-4222-8222-222222222222';
const sellerId = '33333333-3333-4333-8333-333333333333';
const reviewId = '44444444-4444-4444-8444-444444444444';
let client;

beforeEach(() => {
  jest.clearAllMocks();
  orders.lockReviewOrder.mockResolvedValue({
    id: orderId,
    buyer_id: buyerId,
    seller_id: sellerId,
    status: 'completed',
    delivered_at: new Date('2026-01-01T12:00:00.000Z'),
  });
  disputes.hasOpenDisputeInTransaction.mockResolvedValue(false);
  returnRequests.hasOpenReturnRequest.mockResolvedValue(false);
  chargebacks.hasOpenPayoutIssue.mockResolvedValue(false);
  sellerPayouts.getBusinessDate.mockResolvedValue('2026-01-10');
  settlement.getSettingsForTransaction.mockResolvedValue({ review_window_days: '14' });
  eventBus.emitAsync.mockResolvedValue(true);
  client = {
    query: jest.fn(async (sql) => {
      if (sql.includes('SELECT $1::date <=')) return { rows: [{ in_window: true }] };
      if (sql.includes('INSERT INTO reviews')) {
        return {
          rows: [{
            id: reviewId,
            order_id: orderId,
            direction: 'buyer_to_seller',
            rating: 5,
            item_rating: 4,
            body: 'Great service.',
            state: 'hidden_until_reveal',
            revealed_at: null,
            created_at: new Date('2026-01-10T12:00:00.000Z'),
          }],
        };
      }
      if (sql.includes('count(*)::int AS review_count')) return { rows: [{ review_count: 1 }] };
      if (sql.includes('FROM reviews WHERE id = $1')) {
        return {
          rows: [{
            id: reviewId,
            order_id: orderId,
            direction: 'buyer_to_seller',
            rating: 5,
            item_rating: 4,
            body: 'Great service.',
            state: 'hidden_until_reveal',
            revealed_at: null,
            created_at: new Date('2026-01-10T12:00:00.000Z'),
          }],
        };
      }
      throw new Error(`Unexpected SQL in review unit test: ${sql}`);
    }),
  };
  db.withTransaction.mockImplementation((callback) => callback(client));
});

describe('FR-27b reviews service', () => {
  test('FR-27b: submission stores buyer item rating and initially hides the review', async () => {
    await expect(reviews.submitReview(orderId, buyerId, {
      rating: 5,
      itemRating: 4,
      body: '  Great service.  ',
    })).resolves.toMatchObject({
      direction: 'buyer_to_seller',
      rating: 5,
      itemRating: 4,
      body: 'Great service.',
      state: 'hidden_until_reveal',
    });
    expect(eventBus.emitAsync).toHaveBeenCalledWith(
      'review.waiting',
      expect.objectContaining({ orderId, recipientId: sellerId }),
      { transaction: client }
    );
  });

  test('FR-27b: invalid rating is rejected before a database transaction', async () => {
    await expect(reviews.submitReview(orderId, buyerId, { rating: 5.5 }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(db.withTransaction).not.toHaveBeenCalled();
  });
});
