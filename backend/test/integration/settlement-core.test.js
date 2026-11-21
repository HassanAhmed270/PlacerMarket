const {
  adminDeliveredRequest,
  authHeader,
  cleanupHarness,
  createHarness,
  createScenario,
  db,
  getBusinessDate,
  getApp,
  request,
  restoreHandoverTestEnvironment,
} = require('./delivery-handover.helpers');
const crypto = require('crypto');
const { signAccessToken } = require('../../src/lib/jwt');
const settlement = require('../../src/modules/settlement.service');
const users = require('../../src/modules/users.service');
const { encryptStaffTotpSecret, generateTotpCode, generateTotpSecret } = require('../../src/lib/totp');
const { ValidationError } = require('../../src/lib/errors');

let harness;
let businessDate;
let staffTotpSecret;
let previousTotpEncryptionSecret;

async function adjustCommissionForTest(value) {
  const grant = await createCommissionGrant('commission.update');
  return settlement.adjustCommissionPercent(value, harness.adminId, {
    sessionId: grant.sessionId,
    stepUpGrant: grant.grant,
    consumeStepUpGrantWithClient: users.consumeStepUpGrantWithClient,
  });
}

async function createCommissionSession(userId = harness.adminId) {
  const sessionId = crypto.randomUUID();
  await db.query(
    `INSERT INTO auth_sessions
       (id, family_id, user_id, refresh_token_hash, expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '1 hour', now() + interval '1 day')`,
    [sessionId, crypto.randomUUID(), userId, crypto.randomBytes(32).toString('base64url')]
  );
  return sessionId;
}

async function createCommissionGrant(action = 'commission.update', userId = harness.adminId) {
  const sessionId = await createCommissionSession(userId);
  const grant = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO step_up_grants (token_hash, user_id, session_id, action, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '5 minutes')`,
    [crypto.createHash('sha256').update(grant).digest('hex'), userId, sessionId, action]
  );
  return {
    grant,
    sessionId,
    authorization: `Bearer ${signAccessToken(userId, {
      secret: 'delivery-handover-integration-secret',
      sessionId,
    })}`,
  };
}

async function commissionAuditCount(adminId = harness.adminId) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS count FROM money_audit_events
     WHERE actor_id = $1 AND action = 'commission_percent_changed'`,
    [adminId]
  );
  return rows[0].count;
}

beforeAll(async () => {
  harness = await createHarness();
  businessDate = await getBusinessDate();
  previousTotpEncryptionSecret = process.env.STAFF_TOTP_ENCRYPTION_SECRET;
  process.env.STAFF_TOTP_ENCRYPTION_SECRET = 'settlement-core-totp-test-secret-material-over-32-bytes';
  staffTotpSecret = generateTotpSecret();
  const encrypted = encryptStaffTotpSecret(staffTotpSecret);
  await db.query(
    `INSERT INTO staff_totp_credentials
       (user_id, encrypted_secret, nonce, auth_tag, key_version, enabled_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [
      harness.adminId,
      encrypted.encryptedSecret,
      encrypted.nonce,
      encrypted.authTag,
      encrypted.keyVersion,
    ]
  );
  harness.retained = true;
});

afterEach(async () => {
  await global.drainIntegrationListeners(5000);
});

afterAll(async () => {
  await global.drainIntegrationListeners(5000);
  if (previousTotpEncryptionSecret === undefined) delete process.env.STAFF_TOTP_ENCRYPTION_SECRET;
  else process.env.STAFF_TOTP_ENCRYPTION_SECRET = previousTotpEncryptionSecret;
  await cleanupHarness(harness);
  restoreHandoverTestEnvironment();
});

describe('settlement core integration', () => {
  test('FR-46, FR-47: Buy snapshots the commission percent on the reservation', async () => {
    await adjustCommissionForTest('5');
    const scenario = await createScenario(harness);
    const { rows } = await db.query(
      'SELECT commission_percent_snapshot FROM reservations WHERE id = $1',
      [scenario.reservationId]
    );
    expect(rows[0].commission_percent_snapshot).toBe('5.00');
  });

  test("FR-46: changing the commission setting later does not change an existing reservation's snapshot or its settlement, and applies to the next Buy", async () => {
    await adjustCommissionForTest('5');
    const firstScenario = await createScenario(harness);
    const { rows: firstBefore } = await db.query(
      'SELECT commission_percent_snapshot, item_price_snapshot FROM reservations WHERE id = $1',
      [firstScenario.reservationId]
    );
    expect(firstBefore[0].commission_percent_snapshot).toBe('5.00');

    // Change global commission setting to 8%
    await adjustCommissionForTest('8');

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
    await adjustCommissionForTest('5');
  });

  test('FR-47: recording a settlement is idempotent under ten parallel calls (one settlement row, zero commission or payable entries)', async () => {
    await adjustCommissionForTest('5');
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
    expect(commissionEntries).toHaveLength(0);

    const { rows: payableEntries } = await db.query(
      "SELECT * FROM ledger_entries WHERE order_id = $1 AND entry_type = 'seller_payable'",
      [scenario.orderId]
    );
    expect(payableEntries).toHaveLength(0);

    const { rows: allLedger } = await db.query(
      'SELECT * FROM ledger_entries WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(allLedger).toHaveLength(0);
  });

  test('FR-50a: a succeeded partial refund reduces commission and seller net, and the stored refunded_item_amount matches', async () => {
    await adjustCommissionForTest('5');
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

    await expect(adjustCommissionForTest(0)).resolves.toMatchObject({ value: '0' });
    await expect(adjustCommissionForTest(100)).resolves.toMatchObject({ value: '100' });
    await expect(adjustCommissionForTest(5)).resolves.toMatchObject({ value: '5' });
  });

  describe('FR-50 Admin commission setting route', () => {
    let originalCommissionPercent;

    beforeEach(async () => {
      originalCommissionPercent = await settlement.getSetting('commission_percent');
    });

    afterEach(async () => {
      await adjustCommissionForTest(originalCommissionPercent);
    });

    test('FR-50: rejected commission updates preserve the setting and valid PUT repairs malformed stored data', async () => {
      const malformedGrant = await createCommissionGrant();
      await request(getApp())
        .put('/api/settlement/commission')
        .set('Authorization', malformedGrant.authorization)
        .send({ percent: '12.345', stepUpGrant: malformedGrant.grant })
        .expect(400);
      expect(await settlement.getSetting('commission_percent')).toBe(originalCommissionPercent);

      const scenario = await createScenario(harness);
      const { rows: reservationRows } = await db.query(
        'SELECT item_price_snapshot FROM reservations WHERE id = $1',
        [scenario.reservationId]
      );
      const itemPrice = reservationRows[0].item_price_snapshot;
      const expectedBeforeRepair = settlement.calculateReservationSettlement(
        itemPrice,
        originalCommissionPercent
      );
      const beforeRepair = await settlement.calculateSettlement(scenario.orderId, {
        agreedItemPrice: itemPrice,
      });
      expect(beforeRepair.commission_amount).toBe(expectedBeforeRepair.commissionAmount);
      expect(beforeRepair.seller_net_payout).toBe(expectedBeforeRepair.sellerNetAmount);

      await settlement.setSetting('commission_percent', '1e1', harness.adminId);
      await expect(settlement.calculateSettlement(scenario.orderId, { agreedItemPrice: itemPrice }))
        .rejects.toBeInstanceOf(ValidationError);

      const validGrant = await createCommissionGrant();
      await request(getApp())
        .put('/api/settlement/commission')
        .set('Authorization', validGrant.authorization)
        .send({ percent: 7.5, stepUpGrant: validGrant.grant })
        .expect(200)
        .expect(({ body }) => expect(body.value).toBe('7.5'));
      const expectedAfterRepair = settlement.calculateReservationSettlement(itemPrice, '7.5');
      const afterRepair = await settlement.calculateSettlement(scenario.orderId, {
        agreedItemPrice: itemPrice,
      });
      expect(afterRepair.commission_amount).toBe(expectedAfterRepair.commissionAmount);
      expect(afterRepair.seller_net_payout).toBe(expectedAfterRepair.sellerNetAmount);
    });

    test('FR-58: commission.update grants are created and every existing action remains allowed while unknown actions are rejected', async () => {
      const sessionId = await createCommissionSession();
      const actions = [
        'payout.update', 'password.change', 'security.change', 'payout.force_release',
        'refund.request', 'refund.decide', 'payout.record', 'payout.approve', 'payout.export',
      ];
      for (const action of actions) {
        await db.query(
          `INSERT INTO step_up_grants (token_hash, user_id, session_id, action, expires_at)
           VALUES ($1, $2, $3, $4, now() + interval '5 minutes')`,
          [crypto.randomBytes(32).toString('hex'), harness.adminId, sessionId, action]
        );
      }
      await expect(db.query(
        `INSERT INTO step_up_grants (token_hash, user_id, session_id, action, expires_at)
         VALUES ($1, $2, $3, 'unknown.action', now() + interval '5 minutes')`,
        [crypto.randomBytes(32).toString('hex'), harness.adminId, sessionId]
      )).rejects.toMatchObject({ code: '23514' });

      const { grant } = await users.createStepUpGrant(
        harness.adminId,
        sessionId,
        'commission.update',
        generateTotpCode(staffTotpSecret)
      );
      expect(grant).toMatch(/^[A-Za-z0-9_-]{43}$/);
      await expect(users.createStepUpGrant(
        harness.adminId,
        sessionId,
        'unknown.action',
        'unused-code'
      )).rejects.toBeInstanceOf(ValidationError);
    });

    test('FR-50, FR-58: all three commission routes reject a missing grant without changing the setting or writing an audit', async () => {
      const sessionId = await createCommissionSession();
      const authorization = `Bearer ${signAccessToken(harness.adminId, {
        secret: 'delivery-handover-integration-secret',
        sessionId,
      })}`;
      const beforeAuditCount = await commissionAuditCount();
      const requests = [
        request(getApp()).put('/api/settlement/commission'),
        request(getApp()).patch('/api/settlement/commission'),
        request(getApp()).patch('/api/admin/fees/commission'),
      ];
      for (const call of requests) {
        await call
          .set('Authorization', authorization)
          .send({ percent: '6.25' })
          .expect(403);
      }
      expect(await settlement.getSetting('commission_percent')).toBe(originalCommissionPercent);
      expect(await commissionAuditCount()).toBe(beforeAuditCount);
    });

    test('FR-50, FR-58: a payout.record grant cannot change commission or write an audit', async () => {
      const wrongAction = await createCommissionGrant('payout.record');
      const beforeAuditCount = await commissionAuditCount();
      await request(getApp())
        .put('/api/settlement/commission')
        .set('Authorization', wrongAction.authorization)
        .send({ percent: '6.25', stepUpGrant: wrongAction.grant })
        .expect(403);
      expect(await settlement.getSetting('commission_percent')).toBe(originalCommissionPercent);
      expect(await commissionAuditCount()).toBe(beforeAuditCount);
    });

    test('FR-50, FR-58: a valid grant updates commission and writes one event with actor and previous/new values', async () => {
      const validGrant = await createCommissionGrant();
      const beforeAuditCount = await commissionAuditCount();
      await request(getApp())
        .put('/api/settlement/commission')
        .set('Authorization', validGrant.authorization)
        .send({ percent: '6.75', stepUpGrant: validGrant.grant })
        .expect(200);
      expect(await settlement.getSetting('commission_percent')).toBe('6.75');
      expect(await commissionAuditCount()).toBe(beforeAuditCount + 1);
      const { rows } = await db.query(
        `SELECT actor_id, action, order_id, payment_id, metadata
         FROM money_audit_events
         WHERE actor_id = $1 AND action = 'commission_percent_changed'
         ORDER BY created_at DESC LIMIT 1`,
        [harness.adminId]
      );
      expect(rows[0]).toEqual({
        actor_id: harness.adminId,
        action: 'commission_percent_changed',
        order_id: null,
        payment_id: null,
        metadata: { previousPercent: originalCommissionPercent, newPercent: '6.75' },
      });
    });

    test('FR-50, FR-58: submitting the current commission value still writes an audit event', async () => {
      const validGrant = await createCommissionGrant();
      const beforeAuditCount = await commissionAuditCount();
      await request(getApp())
        .patch('/api/settlement/commission')
        .set('Authorization', validGrant.authorization)
        .send({ percent: originalCommissionPercent, stepUpGrant: validGrant.grant })
        .expect(200);
      expect(await commissionAuditCount()).toBe(beforeAuditCount + 1);
    });

    test('FR-50, FR-58: reusing a commission grant is rejected without a second event', async () => {
      const validGrant = await createCommissionGrant();
      const beforeAuditCount = await commissionAuditCount();
      const payload = { percent: '6.80', stepUpGrant: validGrant.grant };
      await request(getApp())
        .patch('/api/settlement/commission')
        .set('Authorization', validGrant.authorization)
        .send(payload)
        .expect(200);
      await request(getApp())
        .patch('/api/admin/fees/commission')
        .set('Authorization', validGrant.authorization)
        .send(payload)
        .expect(403);
      expect(await settlement.getSetting('commission_percent')).toBe('6.80');
      expect(await commissionAuditCount()).toBe(beforeAuditCount + 1);
    });

    test.each(['12.345', '1e1', ' 5'])('FR-50, FR-58: malformed percent %j is rejected without consuming its grant', async (percent) => {
      const validGrant = await createCommissionGrant();
      const beforeAuditCount = await commissionAuditCount();
      await request(getApp())
        .put('/api/settlement/commission')
        .set('Authorization', validGrant.authorization)
        .send({ percent, stepUpGrant: validGrant.grant })
        .expect(400);
      const { rows } = await db.query(
        'SELECT consumed_at FROM step_up_grants WHERE token_hash = $1',
        [crypto.createHash('sha256').update(validGrant.grant).digest('hex')]
      );
      expect(rows[0].consumed_at).toBeNull();
      expect(await settlement.getSetting('commission_percent')).toBe(originalCommissionPercent);
      expect(await commissionAuditCount()).toBe(beforeAuditCount);
    });

    test('FR-50, FR-58: a Moderator is forbidden from changing commission even with a valid grant', async () => {
      const moderatorGrant = await createCommissionGrant('commission.update', harness.moderatorId);
      const beforeAuditCount = await commissionAuditCount();
      await request(getApp())
        .patch('/api/admin/fees/commission')
        .set('Authorization', moderatorGrant.authorization)
        .send({ percent: '6.90', stepUpGrant: moderatorGrant.grant })
        .expect(403);
      expect(await settlement.getSetting('commission_percent')).toBe(originalCommissionPercent);
      expect(await commissionAuditCount()).toBe(beforeAuditCount);
    });
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

  test('FR-47: a payout release writes exactly one cash ledger entry (seller_payout_manual) and no commission or seller_payable entries', async () => {
    await adjustCommissionForTest('5');
    const scenario = await createScenario(harness);

    await db.query(
      `UPDATE orders
       SET status = 'handed_to_delivery', handed_over_at = now() - INTERVAL '5 minutes'
       WHERE id = $1`,
      [scenario.orderId]
    );
    await adminDeliveredRequest(harness, scenario, { note: 'Delivered for payout test' }).expect(200);

    await db.query(
      `UPDATE payout_holds
       SET hold_started_at = now() - INTERVAL '10 days'
       WHERE order_id = $1`,
      [scenario.orderId]
    );
    await db.query(
      `UPDATE orders SET delivered_at = now() - INTERVAL '10 days' WHERE id = $1`,
      [scenario.orderId]
    );

    const releaseRes = await request(getApp())
      .post(`/api/admin/orders/${scenario.orderId}/payout/release`)
      .set('Authorization', authHeader(harness.adminId))
      .send({
        payoutReference: 'bank-ref-cash-only',
        note: 'Manual transfer confirmed for FR-47',
      })
      .expect(200);

    const { rows: settlementRows } = await db.query(
      'SELECT * FROM settlements WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(settlementRows).toHaveLength(1);

    const { rows: ledgerBeforePaid } = await db.query(
      'SELECT entry_type, amount FROM ledger_entries WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(ledgerBeforePaid).toHaveLength(0);

    const adminSessionId = crypto.randomUUID();
    await db.query(
      `INSERT INTO auth_sessions (id, family_id, user_id, refresh_token_hash, expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour', now() + interval '1 day')`,
      [adminSessionId, crypto.randomUUID(), harness.adminId, crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex')]
    );
    const grant = crypto.randomBytes(32).toString('base64url');
    await db.query(
      `INSERT INTO step_up_grants (token_hash, user_id, session_id, action, expires_at)
       VALUES ($1, $2, $3, 'payout.record', now() + interval '5 minutes')`,
      [crypto.createHash('sha256').update(grant).digest('hex'), harness.adminId, adminSessionId]
    );
    const adminToken = `Bearer ${signAccessToken(harness.adminId, { secret: 'delivery-handover-integration-secret', sessionId: adminSessionId })}`;
    await request(getApp())
      .post(`/api/admin/seller-payouts/${releaseRes.body.payout.id}/paid`)
      .set('Authorization', adminToken)
      .send({
        method: 'bank',
        transferReference: 'bank-ref-cash-only',
        paidOn: businessDate,
        stepUpGrant: grant,
      })
      .expect(200);

    const { rows: ledgerRows } = await db.query(
      'SELECT entry_type, amount FROM ledger_entries WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].entry_type).toBe('seller_payout_manual');
    expect(Number(ledgerRows[0].amount)).toBeLessThan(0);

    const { rows: nonCashEntries } = await db.query(
      "SELECT * FROM ledger_entries WHERE order_id = $1 AND entry_type IN ('commission', 'seller_payable')",
      [scenario.orderId]
    );
    expect(nonCashEntries).toHaveLength(0);
  });
});
