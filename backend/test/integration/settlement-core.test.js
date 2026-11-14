const {
  cleanupHarness,
  createHarness,
  createScenario,
  db,
  restoreHandoverTestEnvironment,
} = require('./delivery-handover.helpers');
const settlement = require('../../src/modules/settlement.service');
const { ValidationError } = require('../../src/lib/errors');

let harness;

beforeAll(async () => {
  harness = await createHarness();
  harness.retained = true;
});

afterEach(async () => {
  await global.drainIntegrationListeners(5000);
});

afterAll(async () => {
  await global.drainIntegrationListeners(5000);
  await cleanupHarness(harness);
  restoreHandoverTestEnvironment();
});

describe('settlement core integration', () => {
  test('FR-46, FR-47: Buy snapshots the commission percent on the reservation', async () => {
    await settlement.adjustCommissionPercent('5', harness.adminId);
    const scenario = await createScenario(harness);
    const { rows } = await db.query(
      'SELECT commission_percent_snapshot FROM reservations WHERE id = $1',
      [scenario.reservationId]
    );
    expect(rows[0].commission_percent_snapshot).toBe('5.00');
  });

  test("FR-46: changing the commission setting later does not change an existing reservation's snapshot or its settlement, and applies to the next Buy", async () => {
    await settlement.adjustCommissionPercent('5', harness.adminId);
    const firstScenario = await createScenario(harness);
    const { rows: firstBefore } = await db.query(
      'SELECT commission_percent_snapshot, item_price_snapshot FROM reservations WHERE id = $1',
      [firstScenario.reservationId]
    );
    expect(firstBefore[0].commission_percent_snapshot).toBe('5.00');

    // Change global commission setting to 8%
    await settlement.adjustCommissionPercent('8', harness.adminId);

    // Existing reservation snapshot remains untouched
    const { rows: firstAfter } = await db.query(
      'SELECT commission_percent_snapshot FROM reservations WHERE id = $1',
      [firstScenario.reservationId]
    );
    expect(firstAfter[0].commission_percent_snapshot).toBe('5.00');

    // Settlement calculation for the existing reservation uses its snapshotted 5%
    const firstSettlement = settlement.calculateReservationSettlement(
      firstBefore[0].item_price_snapshot,
      firstBefore[0].commission_percent_snapshot
    );
    expect(firstSettlement.commissionPercent).toBe('5.00');

    // Next Buy snapshots the new 8% setting
    const secondScenario = await createScenario(harness);
    const { rows: secondRows } = await db.query(
      'SELECT commission_percent_snapshot, item_price_snapshot FROM reservations WHERE id = $1',
      [secondScenario.reservationId]
    );
    expect(secondRows[0].commission_percent_snapshot).toBe('8.00');

    const secondSettlement = settlement.calculateReservationSettlement(
      secondRows[0].item_price_snapshot,
      secondRows[0].commission_percent_snapshot
    );
    expect(secondSettlement.commissionPercent).toBe('8.00');

    // Reset setting back to 5%
    await settlement.adjustCommissionPercent('5', harness.adminId);
  });

  test('FR-47: recording a settlement is idempotent under ten parallel calls (one settlement row, one commission entry, one payable entry)', async () => {
    await settlement.adjustCommissionPercent('5', harness.adminId);
    const scenario = await createScenario(harness);

    // Ten parallel calls to recordReservationSettlement
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        db.withTransaction((client) =>
          settlement.recordReservationSettlement(client, scenario.orderId, harness.adminId)
        )
      )
    );

    for (const res of results) {
      expect(res).toBeTruthy();
      expect(res.order_id).toBe(scenario.orderId);
      expect(Number(res.commission_percent)).toBe(5);
    }

    const { rows: settlementRows } = await db.query(
      'SELECT * FROM settlements WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(settlementRows).toHaveLength(1);

    const { rows: commissionEntries } = await db.query(
      "SELECT * FROM ledger_entries WHERE order_id = $1 AND entry_type = 'commission'",
      [scenario.orderId]
    );
    expect(commissionEntries).toHaveLength(1);
    expect(Number(commissionEntries[0].amount)).toBeGreaterThan(0);
    expect(commissionEntries[0].idempotency_key).toBe(`commission:${scenario.orderId}`);

    const { rows: payableEntries } = await db.query(
      "SELECT * FROM ledger_entries WHERE order_id = $1 AND entry_type = 'seller_payable'",
      [scenario.orderId]
    );
    expect(payableEntries).toHaveLength(1);
    expect(Number(payableEntries[0].amount)).toBeLessThan(0);
    expect(payableEntries[0].idempotency_key).toBe(`seller_payable:${scenario.orderId}`);

    const { rows: allLedger } = await db.query(
      'SELECT * FROM ledger_entries WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(allLedger).toHaveLength(2);
  });

  test('FR-50a: a succeeded partial refund reduces commission and seller net, and the stored refunded_item_amount matches', async () => {
    await settlement.adjustCommissionPercent('5', harness.adminId);
    const scenario = await createScenario(harness);

    const refundId = require('node:crypto').randomUUID();
    await db.query(
      `INSERT INTO refunds
         (id, payment_id, order_id, trigger, amount, currency, status, requested_by, approved_by, idempotency_key)
       VALUES ($1, $2, $3, 'manual_admin', 200.00, 'PKR', 'succeeded', $4, $5, $6)`,
      [refundId, scenario.paymentId, scenario.orderId, harness.adminId, harness.moderatorId, `refund:partial:${refundId}`]
    );

    const recorded = await db.withTransaction((client) =>
      settlement.recordReservationSettlement(client, scenario.orderId, harness.adminId)
    );

    const { rows: resRows } = await db.query(
      'SELECT item_price_snapshot FROM reservations WHERE id = $1',
      [scenario.reservationId]
    );
    const itemPrice = Number(resRows[0].item_price_snapshot);
    const expectedBase = itemPrice - 200;
    const expectedCommission = (Math.round(expectedBase * 5) / 100).toFixed(2);
    const expectedSellerNet = (expectedBase - Number(expectedCommission)).toFixed(2);

    expect(Number(recorded.refunded_item_amount)).toBe(200);
    expect(recorded.commission_amount).toBe(expectedCommission);
    expect(recorded.seller_net_payout).toBe(expectedSellerNet);

    const { rows: dbSettlements } = await db.query(
      'SELECT commission_amount::text, seller_net_payout::text, refunded_item_amount::text FROM settlements WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(dbSettlements[0]).toEqual({
      commission_amount: expectedCommission,
      seller_net_payout: expectedSellerNet,
      refunded_item_amount: '200.00',
    });
  });

  test('FR-46: adjustCommissionPercent rejects values outside 0..100', async () => {
    await expect(settlement.adjustCommissionPercent(-0.01, harness.adminId)).rejects.toThrow(ValidationError);
    await expect(settlement.adjustCommissionPercent(-5, harness.adminId)).rejects.toThrow(ValidationError);
    await expect(settlement.adjustCommissionPercent(100.01, harness.adminId)).rejects.toThrow(ValidationError);
    await expect(settlement.adjustCommissionPercent(150, harness.adminId)).rejects.toThrow(ValidationError);
    await expect(settlement.adjustCommissionPercent('invalid', harness.adminId)).rejects.toThrow(ValidationError);
    await expect(settlement.adjustCommissionPercent(null, harness.adminId)).rejects.toThrow(ValidationError);

    await expect(settlement.adjustCommissionPercent(0, harness.adminId)).resolves.toMatchObject({ value: '0' });
    await expect(settlement.adjustCommissionPercent(100, harness.adminId)).resolves.toMatchObject({ value: '100' });
    await expect(settlement.adjustCommissionPercent(5, harness.adminId)).resolves.toMatchObject({ value: '5' });
  });

  test('FR-46: a reservation inserted without a commission snapshot is rejected because the column has no default', async () => {
    const listingId = harness.fixture.listingId;
    const buyerId = harness.buyerId;
    const sellerId = harness.fixture.userId;
    const cityId = harness.fixture.cityId;

    const countBefore = await db.query(
      'SELECT count(*)::int AS count FROM reservations WHERE listing_id = $1 AND buyer_id = $2',
      [listingId, buyerId]
    );

    await expect(db.query(
      `INSERT INTO reservations
         (listing_id, buyer_id, seller_id, status, item_price_snapshot,
          delivery_fee_snapshot, total_amount_snapshot, currency, recipient_name,
          recipient_phone, city_id, address_line1, expires_at)
       VALUES ($1, $2, $3, 'active', 1000.00, 300.00, 1300.00, 'PKR', 'Test Buyer',
               '+923001234567', $4, '123 Main St', now() + interval '30 minutes')`,
      [listingId, buyerId, sellerId, cityId]
    )).rejects.toMatchObject({ code: '23502' });

    const countAfter = await db.query(
      'SELECT count(*)::int AS count FROM reservations WHERE listing_id = $1 AND buyer_id = $2',
      [listingId, buyerId]
    );
    expect(countAfter.rows[0].count).toBe(countBefore.rows[0].count);
  });
});
