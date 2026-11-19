jest.mock('../../src/db.service', () => ({
  read: jest.fn(),
  withTransaction: jest.fn(),
}));
jest.mock('../../src/modules/sellerPayouts.service', () => ({
  getBusinessDate: jest.fn(),
}));

const db = require('../../src/db.service');
const consistency = require('../../src/modules/settlementConsistency.service');
const { ValidationError } = require('../../src/lib/errors');

describe('FR-70: consistency finding pagination', () => {
  beforeEach(() => jest.clearAllMocks());

  test('FR-70: compares the keyset cursor in SQL and fetches one extra row', async () => {
    const createdAt = '2026-11-18 12:34:56.123456+00';
    const id = '123e4567-e89b-42d3-a456-426614174000';
    const cursor = Buffer.from(JSON.stringify({ createdAt, id })).toString('base64url');
    db.read.mockResolvedValue({ rows: [] });

    await expect(consistency.listSettlementConsistencyFindings({ cursor, limit: '7' }))
      .resolves.toEqual({ findings: [], nextCursor: null });
    expect(db.read).toHaveBeenCalledWith(
      expect.stringContaining('(created_at, id) < ($1::timestamptz, $2::uuid)'),
      [createdAt, id, 8]
    );
  });

  test('FR-70: rejects malformed pagination inputs', async () => {
    await expect(consistency.listSettlementConsistencyFindings({ limit: '0' }))
      .rejects.toBeInstanceOf(ValidationError);
    await expect(consistency.listSettlementConsistencyFindings({ cursor: 'not-a-cursor' }))
      .rejects.toBeInstanceOf(ValidationError);
    expect(db.read).not.toHaveBeenCalled();
  });
});
