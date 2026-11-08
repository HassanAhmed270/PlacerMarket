jest.mock('../../src/db.service', () => ({
  read: jest.fn(),
  query: jest.fn(),
  withTransaction: jest.fn(),
}));
jest.mock('../../src/modules/listings.service', () => ({
  setSystemTakedownHandler: jest.fn(),
}));
jest.mock('../../src/modules/orders.service', () => ({}));
jest.mock('../../src/modules/reservations.service', () => ({}));
jest.mock('../../src/modules/users.service', () => ({}));

const db = require('../../src/db.service');
const escrowPayments = require('../../src/modules/escrowPayments.service');

const refundId = '00000000-0000-4000-8000-000000000001';
const nextRefundId = '00000000-0000-4000-8000-000000000002';
const orderId = '00000000-0000-4000-8000-000000000003';
const requesterId = '00000000-0000-4000-8000-000000000004';
const decisionMakerId = '00000000-0000-4000-8000-000000000005';

beforeEach(() => jest.clearAllMocks());

describe('FR-69 Admin manual refund reads', () => {
  test('FR-69: queue returns only manual requests with full-balance metadata and requester eligibility', async () => {
    const requestedAt = new Date('2026-11-08T10:00:00.000Z');
    db.read.mockResolvedValue({ rows: [
      {
        refundId,
        orderId,
        amount: '1550.50',
        currency: 'PKR',
        status: 'requested',
        requestedBy: requesterId,
        requestedAt,
        expiresAt: new Date('2026-11-10T10:00:00.000Z'),
      },
      {
        refundId: nextRefundId,
        orderId,
        amount: '20.00',
        currency: 'PKR',
        status: 'approved',
        requestedBy: decisionMakerId,
        requestedAt,
        expiresAt: new Date('2026-11-10T10:00:00.000Z'),
      },
    ] });

    await expect(escrowPayments.listAdminManualRefunds({ limit: '1' }, requesterId)).resolves.toEqual({
      refunds: [{
        refundId,
        orderId,
        amount: '1550.50',
        currency: 'PKR',
        status: 'requested',
        requestedBy: requesterId,
        requestedAt,
        expiresAt: new Date('2026-11-10T10:00:00.000Z'),
        requestedByMe: true,
      }],
      nextBefore: refundId,
    });
    const [sql, values] = db.read.mock.calls[0];
    expect(sql).toContain("trigger = 'manual_admin'");
    expect(sql).toContain("requested_at + INTERVAL '48 hours'");
    expect(sql).toContain('ORDER BY requested_at DESC, id DESC');
    expect(sql).not.toMatch(/provider_refund_id|idempotency_key/i);
    expect(values).toEqual([null, null, 2]);
  });

  test('FR-69: queue cursor is validated and page size is capped at 50', async () => {
    const requestedAt = new Date('2026-11-08T10:00:00.000Z');
    db.read.mockResolvedValueOnce({ rows: [{ id: refundId, requested_at: requestedAt }] });
    db.read.mockResolvedValueOnce({ rows: [] });

    await expect(escrowPayments.listAdminManualRefunds({ limit: '500', before: refundId }, requesterId))
      .resolves.toEqual({ refunds: [], nextBefore: null });
    expect(db.read.mock.calls[1][1]).toEqual([requestedAt, refundId, 51]);
    await expect(escrowPayments.listAdminManualRefunds({ before: 'invalid' }, requesterId))
      .rejects.toThrow('before must be a manual refund UUID.');

    db.read.mockResolvedValueOnce({ rows: [] });
    await expect(escrowPayments.listAdminManualRefunds({ before: nextRefundId }, requesterId))
      .rejects.toThrow('before must identify a manual refund.');
  });

  test('FR-69: detail is limited to manual refunds and marks whether the viewer requested it', async () => {
    db.read.mockResolvedValue({ rows: [{
      refundId,
      orderId,
      amount: '1550.50',
      currency: 'PKR',
      status: 'requested',
      requestedBy: requesterId,
      approvedBy: null,
      requestedAt: new Date('2026-11-08T10:00:00.000Z'),
      expiresAt: new Date('2026-11-10T10:00:00.000Z'),
      approvedAt: null,
      decidedAt: null,
      reason: 'Customer service reviewed the delivery issue.',
      decisionNote: null,
    }] });

    const result = await escrowPayments.getAdminManualRefund(refundId, decisionMakerId);
    expect(result).toMatchObject({
      refundId,
      requestedBy: requesterId,
      requestedByMe: false,
      reason: 'Customer service reviewed the delivery issue.',
    });
    expect(db.read.mock.calls[0][0]).toContain("trigger = 'manual_admin'");
    expect(db.read.mock.calls[0][0]).not.toMatch(/provider_refund_id|idempotency_key/i);

    db.read.mockResolvedValueOnce({ rows: [] });
    await expect(escrowPayments.getAdminManualRefund(nextRefundId, decisionMakerId))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});
