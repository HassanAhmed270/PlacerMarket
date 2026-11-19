const crypto = require('node:crypto');
const db = require('../../src/db.service');
const consistency = require('../../src/modules/settlementConsistency.service');
const { createFixture } = require('./fixtures');

jest.setTimeout(30000);

const MONEY_TABLES = [
  ['payments', 'id'],
  ['refunds', 'id'],
  ['ledger_entries', 'id'],
  ['seller_payouts', 'id'],
  ['payout_holds', 'order_id'],
  ['settlements', 'order_id'],
  ['orders', 'id'],
];

describe('FR-70: settlement consistency findings on PostgreSQL', () => {
  let fixtures = [];

  beforeEach(() => {
    fixtures = [];
  });

  afterEach(async () => {
    for (const fixture of fixtures) {
      await db.query('DELETE FROM offers WHERE listing_id = $1', [fixture.listingId]);
      await db.query('DELETE FROM conversations WHERE listing_id = $1', [fixture.listingId]);
      await fixture.cleanup();
    }
  });

  async function moneySnapshot(client) {
    const snapshot = {};
    for (const [table, key] of MONEY_TABLES) {
      const { rows } = await client.query(
        `SELECT count(*)::text AS row_count,
                md5(COALESCE(string_agg(row_data::text, '' ORDER BY sort_key), '')) AS checksum
         FROM (
           SELECT to_jsonb(record) AS row_data,
                  to_jsonb(record)->>'${key}' AS sort_key
           FROM ${table} record
         ) values_to_hash`
      );
      snapshot[table] = rows[0];
    }
    return snapshot;
  }

  async function scanWithoutMoneyWrites(client) {
    const before = await moneySnapshot(client);
    const report = await consistency.runSettlementConsistencyCheck({
      logger: { info: jest.fn() },
      transaction: client,
    });
    const after = await moneySnapshot(client);
    expect(after).toEqual(before);
    return report;
  }

  async function createOrder(client, fixture) {
    const { rows: conversationRows } = await client.query(
      `INSERT INTO conversations (listing_id, buyer_id, seller_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [fixture.listingId, fixture.otherUserId, fixture.userId]
    );
    const { rows: offerRows } = await client.query(
      `INSERT INTO offers (conversation_id, listing_id, proposed_by, amount, status)
       VALUES ($1, $2, $3, 100, 'accepted') RETURNING id`,
      [conversationRows[0].id, fixture.listingId, fixture.otherUserId]
    );
    const { rows } = await client.query(
      `INSERT INTO orders
         (accepted_offer_id, listing_id, buyer_id, seller_id, agreed_item_price,
          delivery_address, payment_method_preference, status)
       VALUES ($1, $2, $3, $4, 100, '', 'fixed_price_gateway', 'order_placed')
       RETURNING id`,
      [offerRows[0].id, fixture.listingId, fixture.otherUserId, fixture.userId]
    );
    return rows[0].id;
  }

  async function createPayment(client, orderId, { amount = '100.00', status = 'succeeded' } = {}) {
    const { rows } = await client.query(
      `INSERT INTO payments
         (order_id, provider, status, amount, currency, gateway_fee_currency, idempotency_key)
       VALUES ($1, 'fake', $2, $3::numeric, 'PKR', 'PKR', $4)
       RETURNING id`,
      [orderId, status, amount, `consistency-payment:${crypto.randomUUID()}`]
    );
    return rows[0].id;
  }

  async function insertLedgerEntry(client, orderId, {
    paymentId = null, refundId = null, amount, entryType, key = crypto.randomUUID(),
  }) {
    await client.query(
      `INSERT INTO ledger_entries
         (order_id, payment_id, refund_id, currency, amount, entry_type, idempotency_key)
       VALUES ($1, $2, $3, 'PKR', $4::numeric, $5, $6)`,
      [orderId, paymentId, refundId, amount, entryType, `consistency:${key}`]
    );
  }

  async function createSucceededRefund(client, orderId, paymentId, amount = '10.00') {
    const { rows } = await client.query(
      `INSERT INTO refunds
         (payment_id, order_id, trigger, amount, currency, status, idempotency_key)
       VALUES ($1, $2, 'system_cancel', $3::numeric, 'PKR', 'succeeded', $4)
       RETURNING id`,
      [paymentId, orderId, amount, `consistency-refund:${crypto.randomUUID()}`]
    );
    return rows[0].id;
  }

  async function createPaidPayout(client, orderId, sellerId, paidBy, amount = '50.00') {
    await client.query(
      `INSERT INTO seller_payouts
         (order_id, seller_id, attempt, status, amount, currency, initiated_by,
          method, transfer_reference, paid_on, paid_by, paid_at)
       VALUES ($1, $2, 1, 'paid', $3::numeric, 'PKR', $4,
               'bank', 'fixture-transfer', (now() AT TIME ZONE 'Asia/Karachi')::date, $5, now())`,
      [orderId, sellerId, amount, paidBy, paidBy]
    );
  }

  async function expectOneFinding(checkName, setup) {
    const fixture = await createFixture({ askingPrice: '100.00', listingStatus: 'published' });
    fixtures.push(fixture);
    const rollback = new Error('rollback consistency test fixture');
    await expect(db.withTransaction(async (client) => {
      const orderId = await createOrder(client, fixture);
      const clean = await scanWithoutMoneyWrites(client);
      expect(clean.findings.filter((finding) => finding.subjectId === orderId)).toEqual([]);

      const subjectId = await setup(client, fixture, orderId);
      const first = await scanWithoutMoneyWrites(client);
      const firstForSubject = first.findings.filter((finding) => finding.subjectId === subjectId);
      expect(firstForSubject).toEqual([
        expect.objectContaining({ checkName, subjectId }),
      ]);

      const second = await scanWithoutMoneyWrites(client);
      expect(second.findings.filter((finding) => finding.subjectId === subjectId))
        .toEqual(firstForSubject);
      const { rows } = await client.query(
        `SELECT count(*)::int AS count
         FROM consistency_findings
         WHERE check_name = $1 AND subject_id = $2 AND business_date = $3::date`,
        [checkName, subjectId, first.businessDate]
      );
      expect(rows[0].count).toBe(1);
      throw rollback;
    })).rejects.toBe(rollback);
  }

  test('FR-70: clean payment, refund, payout and hold data creates no findings', async () => {
    const fixture = await createFixture({ askingPrice: '100.00', listingStatus: 'published' });
    fixtures.push(fixture);
    const rollback = new Error('rollback consistency test fixture');
    await expect(db.withTransaction(async (client) => {
      const orderId = await createOrder(client, fixture);
      const report = await scanWithoutMoneyWrites(client);
      expect(report.findings.filter((finding) => finding.subjectId === orderId)).toEqual([]);
      throw rollback;
    })).rejects.toBe(rollback);
  });

  test('FR-70: captured payment with duplicate but amount-balanced capture entries creates one idempotent finding', async () => {
    await expectOneFinding('payment_capture_ledger', async (client, fixture, orderId) => {
      const paymentId = await createPayment(client, orderId);
      await insertLedgerEntry(client, orderId, { paymentId, amount: '50.00', entryType: 'capture' });
      await insertLedgerEntry(client, orderId, { paymentId, amount: '50.00', entryType: 'capture' });
      return paymentId;
    });
  });

  test('FR-70: succeeded refund with duplicate but amount-balanced refund entries creates one idempotent finding', async () => {
    await expectOneFinding('successful_refund_ledger', async (client, fixture, orderId) => {
      const paymentId = await createPayment(client, orderId);
      await insertLedgerEntry(client, orderId, { paymentId, amount: '100.00', entryType: 'capture' });
      const refundId = await createSucceededRefund(client, orderId, paymentId);
      await insertLedgerEntry(client, orderId, {
        paymentId, refundId, amount: '-5.00', entryType: 'refund',
      });
      await insertLedgerEntry(client, orderId, {
        paymentId, refundId, amount: '-5.00', entryType: 'refund',
      });
      return refundId;
    });
  });

  test('FR-70: paid payout with duplicate but amount-balanced manual ledger entries creates one idempotent finding', async () => {
    await expectOneFinding('paid_payout_ledger', async (client, fixture, orderId) => {
      const paymentId = await createPayment(client, orderId);
      await insertLedgerEntry(client, orderId, { paymentId, amount: '100.00', entryType: 'capture' });
      await createPaidPayout(client, orderId, fixture.userId, fixture.otherUserId);
      await insertLedgerEntry(client, orderId, {
        paymentId, amount: '-25.00', entryType: 'seller_payout_manual',
      });
      await insertLedgerEntry(client, orderId, {
        paymentId, amount: '-25.00', entryType: 'seller_payout_manual',
      });
      return orderId;
    });
  });

  test('FR-70: a negative per-order ledger sum creates one idempotent finding', async () => {
    await expectOneFinding('order_ledger_sum', async (client, fixture, orderId) => {
      await insertLedgerEntry(client, orderId, { amount: '-1.00', entryType: 'adjustment' });
      return orderId;
    });
  });

  test('FR-70: refund-cap breach creates one idempotent finding', async () => {
    await expectOneFinding('refund_cap', async (client, fixture, orderId) => {
      const paymentId = await createPayment(client, orderId, { amount: '50.00', status: 'pending' });
      await client.query(
        `INSERT INTO refunds
           (payment_id, order_id, trigger, amount, currency, status, idempotency_key)
         VALUES ($1, $2, 'system_cancel', 50, 'PKR', 'requested', $3)`,
        [paymentId, orderId, `consistency-refund:${crypto.randomUUID()}`]
      );
      await client.query('UPDATE payments SET amount = 25 WHERE id = $1', [paymentId]);
      return paymentId;
    });
  });

  test('FR-70: paid payout with an active hold creates one idempotent finding', async () => {
    await expectOneFinding('paid_payout_active_hold', async (client, fixture, orderId) => {
      const paymentId = await createPayment(client, orderId);
      await insertLedgerEntry(client, orderId, { paymentId, amount: '100.00', entryType: 'capture' });
      await createPaidPayout(client, orderId, fixture.userId, fixture.otherUserId);
      await insertLedgerEntry(client, orderId, {
        paymentId, amount: '-50.00', entryType: 'seller_payout_manual',
      });
      await client.query(
        `INSERT INTO payout_holds (order_id, hold_started_at, state)
         VALUES ($1, now(), 'held')`,
        [orderId]
      );
      return orderId;
    });
  });
});
