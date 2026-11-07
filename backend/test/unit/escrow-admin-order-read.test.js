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

describe('FR-68 Admin order payment and refund summary', () => {
  test('FR-68: returns decimal-string amounts without provider or webhook details', async () => {
    db.read.mockResolvedValue({ rows: [{
      payment: { status: 'succeeded', amount: '1550.50' },
      refunds: [{ id: 'refund-1', trigger: 'system_expiry', status: 'failed', amount: '50.25' }],
    }] });
    await expect(escrowPayments.getAdminOrderPaymentAndRefunds('order-1')).resolves.toEqual({
      payment: { status: 'succeeded', amount: '1550.50' },
      refunds: [{ id: 'refund-1', trigger: 'system_expiry', status: 'failed', amount: '50.25' }],
    });
    const sql = db.read.mock.calls[0][0];
    expect(sql).not.toMatch(/provider_reference|provider_payment_id|webhook_inbox|raw_body/i);
  });
});
