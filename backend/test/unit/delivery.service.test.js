jest.mock('../../src/db.service', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(),
  withTransactionRetry: jest.fn(),
}));
jest.mock('../../src/modules/escrowPayments.service', () => ({
  lockPaymentAndRefundRowsForHandover: jest.fn(),
  recordOrderExceptionResolvedAuditEvent: jest.fn(),
}));
jest.mock('../../src/modules/orders.service', () => ({}));
jest.mock('../../src/modules/reservations.service', () => ({}));
jest.mock('../../src/modules/listings.service', () => ({}));
jest.mock('../../src/modules/users.service', () => ({}));
jest.mock('../../src/modules/payout.service', () => ({}));

const db = require('../../src/db.service');
const escrowPayments = require('../../src/modules/escrowPayments.service');
const delivery = require('../../src/modules/delivery.service');

const exceptionId = '11111111-1111-4111-8111-111111111111';
const adminId = '22222222-2222-4222-8222-222222222222';
const orderId = '33333333-3333-4333-8333-333333333333';
const client = { query: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  db.withTransaction.mockImplementation((callback) => callback(client));
});

describe('delivery.service order exceptions — FR-72e', () => {
  test('FR-72e: list filters status and kind with a hard maximum limit of 100', async () => {
    db.query.mockResolvedValue({ rows: [] });

    await expect(delivery.listOrderExceptions({
      status: 'all',
      kind: 'handover_after_cancel',
      limit: '1000',
    })).resolves.toEqual([]);

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('kind = $1'),
      ['handover_after_cancel', 100]
    );
    expect(db.query.mock.calls[0][0]).toContain('ORDER BY recorded_at DESC, id DESC');
  });

  test('FR-72e: resolve locks the exception and writes its audit record in the same transaction', async () => {
    const updated = {
      id: exceptionId,
      orderId,
      kind: 'handover_after_cancel',
      resolvedBy: adminId,
      resolutionNote: 'Resolution confirmed',
    };
    client.query
      .mockResolvedValueOnce({
        rows: [{
          id: exceptionId,
          order_id: orderId,
          kind: 'handover_after_cancel',
          resolved_at: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [updated] });

    await expect(delivery.resolveOrderException(exceptionId, {
      resolvedBy: adminId,
      resolutionNote: '  Resolution confirmed  ',
    })).resolves.toEqual(updated);

    expect(db.withTransaction).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(client.query.mock.calls[1][1]).toEqual([exceptionId, adminId, 'Resolution confirmed']);
    expect(escrowPayments.recordOrderExceptionResolvedAuditEvent).toHaveBeenCalledWith(client, {
      orderId,
      adminId,
      exceptionId,
      kind: 'handover_after_cancel',
      resolutionNote: 'Resolution confirmed',
    });
  });
});
