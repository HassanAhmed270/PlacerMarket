/**
 * FR-70: detect inconsistencies across payment, refund, payout and ledger records.
 * Owns: consistency_findings
 */

const db = require('../db.service');
const sellerPayouts = require('./sellerPayouts.service');
const { ValidationError } = require('../lib/errors');

const CHECKS = [
  {
    name: 'payment_capture_ledger',
    sql: `
      WITH captured_payments AS (
        SELECT id, order_id, currency, amount
        FROM payments
        WHERE status IN ('succeeded', 'late', 'partially_refunded', 'refunded')
      ),
      capture_totals AS (
        SELECT payment_id, (array_agg(order_id))[1] AS order_id, min(currency) AS currency,
               sum(amount) AS amount, count(*)::int AS entry_count,
               count(DISTINCT order_id)::int AS order_count,
               count(DISTINCT currency)::int AS currency_count,
               (array_agg(id))[1] AS ledger_id
        FROM ledger_entries
        WHERE entry_type = 'capture' AND payment_id IS NOT NULL
        GROUP BY payment_id
      ),
      compared AS (
        SELECT p.id AS payment_id, l.payment_id AS ledger_payment_id,
               l.ledger_id, p.order_id, l.order_id AS ledger_order_id,
               p.currency, l.currency AS ledger_currency, p.amount,
               l.amount AS ledger_amount, l.entry_count, l.order_count,
               l.currency_count
        FROM captured_payments p
        FULL OUTER JOIN capture_totals l ON l.payment_id = p.id
      )
      SELECT COALESCE(payment_id, ledger_payment_id, ledger_id) AS subject_id,
             CASE WHEN payment_id IS NULL THEN 'unmatched_ledger_entry'
                  WHEN ledger_payment_id IS NULL THEN 'missing_ledger_entry'
                  ELSE 'ledger_mismatch' END AS reason_code
      FROM compared
      WHERE payment_id IS NULL OR ledger_payment_id IS NULL
         OR order_id IS DISTINCT FROM ledger_order_id
         OR currency IS DISTINCT FROM ledger_currency
         OR amount IS DISTINCT FROM ledger_amount
         OR entry_count <> 1 OR order_count <> 1 OR currency_count <> 1
      UNION ALL
      SELECT id, 'unmatched_ledger_entry'
      FROM ledger_entries
      WHERE entry_type = 'capture' AND payment_id IS NULL
    `,
  },
  {
    name: 'successful_refund_ledger',
    sql: `
      WITH successful_refunds AS (
        SELECT id, order_id, payment_id, currency, amount
        FROM refunds
        WHERE status = 'succeeded'
      ),
      refund_totals AS (
        SELECT refund_id, (array_agg(order_id))[1] AS order_id,
               (array_agg(payment_id))[1] AS payment_id,
               min(currency) AS currency, sum(amount) AS amount,
               count(*)::int AS entry_count,
               count(DISTINCT order_id)::int AS order_count,
               count(DISTINCT payment_id)::int AS payment_count,
               count(DISTINCT currency)::int AS currency_count,
               (array_agg(id))[1] AS ledger_id
        FROM ledger_entries
        WHERE entry_type = 'refund' AND refund_id IS NOT NULL
        GROUP BY refund_id
      ),
      compared AS (
        SELECT r.id AS refund_id, l.refund_id AS ledger_refund_id, l.ledger_id,
               r.order_id, l.order_id AS ledger_order_id,
               r.payment_id, l.payment_id AS ledger_payment_id,
               r.currency, l.currency AS ledger_currency, r.amount,
               l.amount AS ledger_amount, l.entry_count, l.order_count,
               l.payment_count, l.currency_count
        FROM successful_refunds r
        LEFT JOIN refund_totals l ON l.refund_id = r.id
      )
      SELECT COALESCE(refund_id, ledger_refund_id, ledger_id) AS subject_id,
             CASE WHEN refund_id IS NULL THEN 'unmatched_ledger_entry'
                  WHEN ledger_refund_id IS NULL THEN 'missing_ledger_entry'
                  ELSE 'ledger_mismatch' END AS reason_code
      FROM compared
      WHERE ledger_refund_id IS NULL
         OR order_id IS DISTINCT FROM ledger_order_id
         OR payment_id IS DISTINCT FROM ledger_payment_id
         OR currency IS DISTINCT FROM ledger_currency
         OR -amount IS DISTINCT FROM ledger_amount
         OR entry_count <> 1 OR order_count <> 1
         OR payment_count <> 1 OR currency_count <> 1
      UNION ALL
      SELECT e.id, 'unmatched_ledger_entry'
      FROM ledger_entries e
      LEFT JOIN refunds r ON r.id = e.refund_id
      WHERE e.entry_type = 'refund' AND e.refund_id IS NULL
      UNION ALL
      SELECT l.ledger_id, 'unmatched_ledger_entry'
      FROM refund_totals l
      LEFT JOIN refunds r ON r.id = l.refund_id
      WHERE r.id IS NULL OR r.status NOT IN ('succeeded', 'reversed')
    `,
  },
  {
    name: 'paid_payout_ledger',
    sql: `
      WITH paid_payouts AS (
        SELECT order_id, sum(amount) AS amount, min(currency) AS currency,
               count(*)::int AS payout_count, count(DISTINCT currency)::int AS currency_count
        FROM seller_payouts
        WHERE status = 'paid'
        GROUP BY order_id
      ),
      payout_totals AS (
        SELECT order_id, sum(amount) AS amount, min(currency) AS currency,
               count(*)::int AS entry_count,
               count(DISTINCT currency)::int AS currency_count,
               (array_agg(id))[1] AS ledger_id
        FROM ledger_entries
        WHERE entry_type = 'seller_payout_manual'
        GROUP BY order_id
      ),
      compared AS (
        SELECT p.order_id AS payout_order_id, l.order_id AS ledger_order_id,
               p.amount, l.amount AS ledger_amount, p.currency,
               l.currency AS ledger_currency, p.payout_count, p.currency_count,
               l.entry_count, l.currency_count AS ledger_currency_count, l.ledger_id
        FROM paid_payouts p
        FULL OUTER JOIN payout_totals l ON l.order_id = p.order_id
      )
      SELECT COALESCE(payout_order_id, ledger_order_id, ledger_id) AS subject_id,
             CASE WHEN payout_order_id IS NULL THEN 'unmatched_ledger_entry'
                  WHEN ledger_order_id IS NULL THEN 'missing_ledger_entry'
                  ELSE 'ledger_mismatch' END AS reason_code
      FROM compared
      WHERE payout_order_id IS NULL OR ledger_order_id IS NULL
         OR -amount IS DISTINCT FROM ledger_amount
         OR currency IS DISTINCT FROM ledger_currency
         OR payout_count <> 1 OR entry_count <> 1 OR currency_count <> 1
         OR ledger_currency_count <> 1
    `,
  },
  {
    name: 'order_ledger_sum',
    sql: `
      WITH captured AS (
        SELECT order_id, sum(amount) AS amount
        FROM payments
        WHERE status IN ('succeeded', 'late', 'partially_refunded', 'refunded')
        GROUP BY order_id
      ),
      refunded AS (
        SELECT order_id, sum(amount) AS amount
        FROM refunds
        WHERE status = 'succeeded'
        GROUP BY order_id
      ),
      paid_out AS (
        SELECT order_id, sum(amount) AS amount
        FROM seller_payouts
        WHERE status = 'paid'
        GROUP BY order_id
      ),
      expected AS (
        SELECT order_id, sum(amount) AS amount
        FROM (
          SELECT order_id, amount FROM captured
          UNION ALL
          SELECT order_id, -amount FROM refunded
          UNION ALL
          SELECT order_id, -amount FROM paid_out
        ) financial_events
        GROUP BY order_id
      ),
      ledger_totals AS (
        SELECT order_id, sum(amount) AS amount
        FROM ledger_entries
        WHERE order_id IS NOT NULL
        GROUP BY order_id
      )
      SELECT COALESCE(e.order_id, l.order_id) AS subject_id,
             CASE WHEN COALESCE(l.amount, 0) < 0 THEN 'negative_ledger_sum'
                  ELSE 'ledger_sum_mismatch' END AS reason_code
      FROM expected e
      FULL OUTER JOIN ledger_totals l ON l.order_id = e.order_id
      WHERE COALESCE(l.amount, 0) < 0
         OR COALESCE(l.amount, 0) IS DISTINCT FROM COALESCE(e.amount, 0)
    `,
  },
  {
    name: 'refund_cap',
    sql: `
      SELECT p.id AS subject_id, 'refund_cap_exceeded' AS reason_code
      FROM payments p
      JOIN refunds r ON r.payment_id = p.id
      WHERE r.status IN ('requested', 'approved', 'pending', 'succeeded')
      GROUP BY p.id, p.amount
      HAVING sum(r.amount) > p.amount
    `,
  },
  {
    name: 'paid_payout_active_hold',
    sql: `
      SELECT DISTINCT p.order_id AS subject_id, 'paid_payout_active_hold' AS reason_code
      FROM seller_payouts p
      JOIN payout_holds h ON h.order_id = p.order_id
      WHERE p.status = 'paid' AND h.state IN ('held', 'paused_for_dispute')
    `,
  },
];

function parseLimit(value) {
  if (value === undefined) return 50;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new ValidationError('limit must be an integer from 1 to 100.');
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > 100) {
    throw new ValidationError('limit must be an integer from 1 to 100.');
  }
  return limit;
}

function decodeCursor(cursor) {
  if (cursor === undefined || cursor === '') return null;
  if (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new ValidationError('cursor is invalid.');
  }
  let value;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ValidationError('cursor is invalid.');
  }
  if (!value || typeof value !== 'object' ||
      typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt)) ||
      typeof value.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id)) {
    throw new ValidationError('cursor is invalid.');
  }
  return { createdAt: value.createdAt, id: value.id };
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({
    createdAt: row.cursor_created_at,
    id: row.id,
  })).toString('base64url');
}

/** FR-70: run read-only money consistency checks and append one finding per subject and business day. */
async function runSettlementConsistencyCheck({ logger = console, transaction } = {}) {
  if (transaction && typeof transaction.query !== 'function') {
    throw new ValidationError('transaction must provide a query function.');
  }
  const collectReport = async (client) => {
    const businessDate = await sellerPayouts.getBusinessDate(client);
    const findings = [];
    const countsByCheck = {};

    for (const check of CHECKS) {
      const { rows } = await client.query(check.sql);
      countsByCheck[check.name] = rows.length;
      for (const row of rows) {
        findings.push({
          checkName: check.name,
          subjectId: row.subject_id,
          businessDate,
          reasonCode: row.reason_code,
        });
      }
    }

    if (findings.length) {
      await client.query(
        `INSERT INTO consistency_findings (check_name, subject_id, business_date, reason_code)
         SELECT finding.check_name, finding.subject_id, finding.business_date::date, finding.reason_code
         FROM jsonb_to_recordset($1::jsonb) AS finding(
           check_name text, subject_id uuid, business_date text, reason_code text
         )
         ON CONFLICT (check_name, subject_id, business_date) DO NOTHING`,
        [JSON.stringify(findings.map((finding) => ({
          check_name: finding.checkName,
          subject_id: finding.subjectId,
          business_date: finding.businessDate,
          reason_code: finding.reasonCode,
        })))]
      );
    }

    return {
      businessDate,
      findings,
      countsByCheck,
      totalFindings: findings.length,
    };
  };
  const report = transaction
    ? await collectReport(transaction)
    : await db.withTransaction(collectReport);

  logger.info('Settlement consistency check completed', {
    businessDate: report.businessDate,
    totalFindings: report.totalFindings,
    countsByCheck: report.countsByCheck,
  });
  return report;
}

/** FR-70: return Admin-visible consistency findings using SQL keyset pagination. */
async function listSettlementConsistencyFindings({ cursor, limit: rawLimit } = {}) {
  const limit = parseLimit(rawLimit);
  const decoded = decodeCursor(cursor);
  const { rows } = await db.read(
    `SELECT id, check_name, subject_id, business_date::text AS business_date,
            reason_code, created_at, created_at::text AS cursor_created_at
     FROM consistency_findings
     WHERE $1::timestamptz IS NULL
        OR (created_at, id) < ($1::timestamptz, $2::uuid)
     ORDER BY created_at DESC, id DESC
     LIMIT $3`,
    [decoded?.createdAt || null, decoded?.id || null, limit + 1]
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    findings: page.map((row) => ({
      id: row.id,
      checkName: row.check_name,
      subjectId: row.subject_id,
      businessDate: row.business_date,
      reasonCode: row.reason_code,
      createdAt: row.created_at,
    })),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
  };
}

module.exports = {
  runSettlementConsistencyCheck,
  listSettlementConsistencyFindings,
};
