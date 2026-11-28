const db = require('../../src/db.service');
const listings = require('../../src/modules/listings.service');
const escrowPayments = require('../../src/modules/escrowPayments.service');
const orders = require('../../src/modules/orders.service');
const settlementConsistency = require('../../src/modules/settlementConsistency.service');
const sellerPayouts = require('../../src/modules/sellerPayouts.service');

describe('FR-79g: service defaults emit production JSON logs', () => {
  test('reservation, handover, reconciliation, and consistency logs have UTC timestamps', async () => {
    const previous = {
      nodeEnv: process.env.NODE_ENV,
      logLevel: process.env.LOG_LEVEL,
    };
    process.env.NODE_ENV = 'production';
    process.env.LOG_LEVEL = 'info';
    const stdout = jest.spyOn(console, 'log').mockImplementation(() => {});
    const dbTransaction = jest.spyOn(db, 'withTransaction')
      .mockImplementation(async (callback) => callback({
        query: jest.fn().mockResolvedValue({ rows: [] }),
      }));
    const dbRead = jest.spyOn(db, 'read').mockResolvedValue({ rows: [] });
    const getDueHandoverOrderIds = jest.spyOn(orders, 'getDueHandoverOrderIds').mockResolvedValue([]);
    const getBusinessDate = jest.spyOn(sellerPayouts, 'getBusinessDate').mockResolvedValue('2026-02-02');
    try {
      await listings.expireDueReservations();
      await escrowPayments.sweepUnhandedOverOrders();
      await escrowPayments.reconcileMoneyState();
      await settlementConsistency.runSettlementConsistencyCheck({
        transaction: { query: jest.fn().mockResolvedValue({ rows: [] }) },
      });

      const entries = stdout.mock.calls.map(([line]) => JSON.parse(line));
      expect(entries.map(({ msg }) => msg)).toEqual(expect.arrayContaining([
        'Reservation expiry sweep completed',
        'Handover timeout sweep completed',
        'Money reconciliation completed',
        'Settlement consistency check completed',
      ]));
      expect(entries.every(({ time }) => /T.*Z$/.test(time))).toBe(true);
    } finally {
      stdout.mockRestore();
      dbTransaction.mockRestore();
      dbRead.mockRestore();
      getDueHandoverOrderIds.mockRestore();
      getBusinessDate.mockRestore();
      if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous.nodeEnv;
      if (previous.logLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previous.logLevel;
    }
  });
});
