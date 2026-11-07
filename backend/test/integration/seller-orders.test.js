const crypto = require('node:crypto');
const {
  authHeader,
  cleanupHarness,
  cleanupScenario,
  createHarness,
  createLegacyOrder,
  createScenario,
  db,
  getApp,
  request,
  restoreHandoverTestEnvironment,
} = require('./delivery-handover.helpers');

let harness;
let scenario;
let scenarios;
let buyerIdentity;

const SELLER_ORDER_KEYS = [
  'cancelledAt',
  'currency',
  'deliveredAt',
  'deliveryCity',
  'disputeStatus',
  'fundedAt',
  'handedOverAt',
  'handoverDeadlineAt',
  'imageUrl',
  'itemPrice',
  'listingId',
  'orderId',
  'payoutHoldState',
  'status',
  'title',
];

function sellerList(userId, query = '') {
  return request(getApp())
    .get(`/api/orders/selling${query}`)
    .set('Authorization', authHeader(userId));
}

function sellerDetail(userId, orderId) {
  return request(getApp())
    .get(`/api/orders/selling/${orderId}`)
    .set('Authorization', authHeader(userId));
}

async function createOtherSeller() {
  const suffix = crypto.randomUUID();
  const { rows } = await db.query(
    `INSERT INTO users (full_name, phone, password_hash, city_id, role)
     VALUES ($1, $2, 'fixture-hash', $3, 'seller')
     RETURNING id`,
    [
      `Other order seller ${suffix}`,
      `+1557${Date.now().toString().slice(-9)}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`,
      harness.fixture.cityId,
    ]
  );
  harness.extraUserIds.push(rows[0].id);
  return rows[0].id;
}

async function readMoneyTableCounts() {
  const { rows } = await db.query(
    `SELECT
       (SELECT count(*)::int FROM money_audit_events) AS money_audit_events,
       (SELECT count(*)::int FROM ledger_entries) AS ledger_entries,
       (SELECT count(*)::int FROM payout_holds) AS payout_holds`
  );
  return rows[0];
}

async function cleanupDisputes() {
  const orderIds = scenarios.map((item) => item.orderId);
  if (!orderIds.length) return;
  await db.query(
    'UPDATE payout_holds SET dispute_id = NULL WHERE order_id = ANY($1::uuid[])',
    [orderIds]
  );
  await db.query(
    `DELETE FROM dispute_evidence
     WHERE dispute_id IN (SELECT id FROM disputes WHERE order_id = ANY($1::uuid[]))`,
    [orderIds]
  );
  await db.query('DELETE FROM disputes WHERE order_id = ANY($1::uuid[])', [orderIds]);
}

beforeEach(async () => {
  harness = await createHarness();
  scenario = await createScenario(harness);
  scenarios = [scenario];
  const email = `seller-order-buyer-${crypto.randomUUID()}@example.test`;
  await db.query('UPDATE users SET email = $1 WHERE id = $2', [email, scenario.buyerId]);
  const { rows } = await db.query(
    'SELECT full_name, phone, email FROM users WHERE id = $1',
    [scenario.buyerId]
  );
  buyerIdentity = { ...rows[0], recipientName: 'Handover Test Recipient', recipientPhone: '+15551234567' };
});

afterEach(async () => {
  await cleanupDisputes();
  for (const item of scenarios) await cleanupScenario(harness, item);
  await cleanupHarness(harness);
  scenario = null;
  scenarios = [];
  harness = null;
  buyerIdentity = null;
});

afterAll(async () => {
  restoreHandoverTestEnvironment();
});

describe('FR-34 seller reservation-backed order reads', () => {
  test('FR-34: seller list and detail expose only the exact safe funded-order fields', async () => {
    const countsBefore = await readMoneyTableCounts();
    const list = await sellerList(harness.fixture.userId)
      .expect(200)
      .expect('Cache-Control', 'private, no-store');
    const detail = await sellerDetail(harness.fixture.userId, scenario.orderId)
      .expect(200)
      .expect('Cache-Control', 'private, no-store');

    expect(list.body).toHaveLength(1);
    expect(Object.keys(list.body[0]).sort()).toEqual(SELLER_ORDER_KEYS);
    expect(Object.keys(detail.body).sort()).toEqual(SELLER_ORDER_KEYS);
    expect(list.body[0]).toMatchObject({
      orderId: scenario.orderId,
      listingId: scenario.listingId,
      title: expect.stringContaining('Handover listing'),
      imageUrl: null,
      status: 'funded',
      itemPrice: '1250.50',
      currency: 'PKR',
      deliveryCity: expect.any(String),
      payoutHoldState: null,
      disputeStatus: null,
    });
    expect(detail.body).toEqual(list.body[0]);

    const serialized = JSON.stringify([list.body, detail.body]);
    for (const privateValue of Object.values(buyerIdentity)) {
      expect(serialized).not.toContain(privateValue);
    }

    expect(await readMoneyTableCounts()).toEqual(countsBefore);
  });

  test('FR-34: other sellers, buyers, legacy, unfunded, and unknown orders share one empty/404 view', async () => {
    const otherSellerId = await createOtherSeller();
    const legacyOrderId = await createLegacyOrder(harness, scenario);
    await db.query(
      `UPDATE orders
       SET status = 'payment_pending', funded_at = NULL
       WHERE id = $1`,
      [scenario.orderId]
    );

    for (const userId of [otherSellerId, scenario.buyerId]) {
      const list = await sellerList(userId).expect(200);
      expect(list.body).toEqual([]);
    }
    expect((await sellerList(harness.fixture.userId).expect(200)).body).toEqual([]);

    const orderIds = [
      scenario.orderId,
      legacyOrderId,
      crypto.randomUUID(),
    ];
    const responses = [];
    for (const orderId of orderIds) {
      responses.push(await sellerDetail(harness.fixture.userId, orderId));
    }
    responses.push(await sellerDetail(otherSellerId, scenario.orderId));
    responses.push(await sellerDetail(scenario.buyerId, scenario.orderId));

    for (const response of responses) expect(response.status).toBe(404);
    for (const response of responses.slice(1)) {
      expect(response.body).toEqual(responses[0].body);
    }

    const invalidId = await sellerDetail(harness.fixture.userId, 'not-a-uuid').expect(400);
    const buyerSummary = await request(getApp())
      .get('/api/orders/not-a-uuid/summary')
      .set('Authorization', authHeader(harness.fixture.userId))
      .expect(400);
    expect(invalidId.body).toEqual(buyerSummary.body);
  });

  test('FR-34: detail follows funded, handover, delivery, dispute, resolution, and cancellation states', async () => {
    const sellerId = harness.fixture.userId;
    const readDetail = async () => sellerDetail(sellerId, scenario.orderId).expect(200);

    expect((await readDetail()).body.status).toBe('funded');
    await db.query(
      `UPDATE orders
       SET status = 'handed_to_delivery', handed_over_at = now() - INTERVAL '5 minutes'
       WHERE id = $1`,
      [scenario.orderId]
    );
    expect((await readDetail()).body).toMatchObject({
      status: 'handed_to_delivery',
      handedOverAt: expect.any(String),
    });

    await db.query(
      `UPDATE orders SET status = 'delivered', delivered_at = now() WHERE id = $1`,
      [scenario.orderId]
    );
    await db.query(
      `INSERT INTO payout_holds (order_id, hold_started_at, state)
       VALUES ($1, now(), 'held')`,
      [scenario.orderId]
    );
    expect((await readDetail()).body).toMatchObject({
      status: 'delivered',
      payoutHoldState: 'held',
    });

    const { rows: disputes } = await db.query(
      `INSERT INTO disputes (order_id, raised_by, reason_text, status)
       VALUES ($1, $2, 'Test dispute reason must not be returned.', 'open')
       RETURNING id`,
      [scenario.orderId, scenario.buyerId]
    );
    await db.query(
      `UPDATE payout_holds
       SET state = 'paused_for_dispute', dispute_id = $2
       WHERE order_id = $1`,
      [scenario.orderId, disputes[0].id]
    );
    const filed = await readDetail();
    expect(filed.body).toMatchObject({
      status: 'delivered',
      payoutHoldState: 'paused_for_dispute',
      disputeStatus: 'open',
    });
    expect(JSON.stringify(filed.body)).not.toContain('Test dispute reason must not be returned.');

    await db.query(
      `UPDATE disputes SET status = 'resolved_release', resolved_at = now() WHERE id = $1`,
      [disputes[0].id]
    );
    await db.query(
      `UPDATE payout_holds SET state = 'held' WHERE order_id = $1`,
      [scenario.orderId]
    );
    expect((await readDetail()).body.disputeStatus).toBe('resolved_release');

    const cancelledScenario = await createScenario(harness);
    scenarios.push(cancelledScenario);
    await db.query(
      `UPDATE orders SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
      [cancelledScenario.orderId]
    );
    expect((await sellerDetail(sellerId, cancelledScenario.orderId).expect(200)).body).toMatchObject({
      status: 'cancelled',
      cancelledAt: expect.any(String),
    });
  });

  test('FR-34: list ordering and limit are bounded, and invalid limits match /mine', async () => {
    const additionalScenarios = [await createScenario(harness), await createScenario(harness)];
    scenarios.push(...additionalScenarios);
    const orderedScenarios = [scenario, ...additionalScenarios];
    for (const [index, item] of orderedScenarios.entries()) {
      const ageInMinutes = orderedScenarios.length - index;
      await db.query(
        `UPDATE orders
         SET funded_at = now() - ($1::int * INTERVAL '1 minute'),
             handover_deadline_at = now() - ($1::int * INTERVAL '1 minute') + INTERVAL '72 hours'
         WHERE id = $2`,
        [ageInMinutes, item.orderId]
      );
    }

    const allOrders = await sellerList(harness.fixture.userId).expect(200);
    expect(allOrders.body.map((order) => order.orderId)).toEqual([
      orderedScenarios[2].orderId,
      orderedScenarios[1].orderId,
      orderedScenarios[0].orderId,
    ]);
    const limited = await sellerList(harness.fixture.userId, '?limit=2').expect(200);
    expect(limited.body.map((order) => order.orderId)).toEqual([
      orderedScenarios[2].orderId,
      orderedScenarios[1].orderId,
    ]);

    for (const invalidLimit of ['0', '21', 'abc']) {
      const response = await sellerList(harness.fixture.userId, `?limit=${invalidLimit}`).expect(400);
      const buyerResponse = await request(getApp())
        .get(`/api/orders/mine?limit=${invalidLimit}`)
        .set('Authorization', authHeader(harness.fixture.userId))
        .expect(400);
      expect(response.body).toEqual(buyerResponse.body);
    }
  });

  test('FR-34: routes require authentication and do not capture /selling as an order id', async () => {
    await request(getApp()).get('/api/orders/selling').expect(401);
    await request(getApp()).get(`/api/orders/selling/${scenario.orderId}`).expect(401);
    await request(getApp())
      .get(`/api/orders/selling/${scenario.orderId}`)
      .set('Authorization', authHeader(harness.fixture.userId))
      .expect(200);
  });
});
