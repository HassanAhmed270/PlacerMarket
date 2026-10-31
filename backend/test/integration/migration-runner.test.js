const fs = require('fs');
const path = require('path');
const os = require('os');
const { Pool } = require('pg');
const db = require('../../src/db.service');
const { runMigrations } = require('../../db/migrate');

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDir = path.join(__dirname, '..', '..', 'db', 'migrations');
const initialSchema = fs.readFileSync(path.join(migrationsDir, '001_initial_schema.sql'), 'utf8');
const schemas = new Set();
const applicationMigrationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poshaak-application-migrations-'));
fs.copyFileSync(
  path.join(migrationsDir, '001_initial_schema.sql'),
  path.join(applicationMigrationDir, '001_initial_schema.sql')
);
const authMigrationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poshaak-auth-migrations-'));
fs.copyFileSync(
  path.join(migrationsDir, '001_initial_schema.sql'),
  path.join(authMigrationDir, '001_initial_schema.sql')
);
fs.copyFileSync(
  path.join(migrationsDir, '003_auth_foundation.sql'),
  path.join(authMigrationDir, '003_auth_foundation.sql')
);
fs.copyFileSync(
  path.join(migrationsDir, '004_email_code_purpose.sql'),
  path.join(authMigrationDir, '004_email_code_purpose.sql')
);
fs.copyFileSync(
  path.join(migrationsDir, '005_staff_totp_replay_guard.sql'),
  path.join(authMigrationDir, '005_staff_totp_replay_guard.sql')
);
const phase4MigrationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poshaak-phase4-migrations-'));
const previousHeadMigrationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poshaak-previous-head-migrations-'));
for (const migration of fs.readdirSync(migrationsDir).filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file))) {
  const migrationNumber = Number(migration.match(/^\d+/)[0]);
  let contents = fs.readFileSync(path.join(migrationsDir, migration), 'utf8');
  if (migration === '016_listing_search.sql') {
    // The isolated schema is not on public search_path, so qualify the existing shared extension opclass.
    contents = contents.replace('search_text gin_trgm_ops', 'search_text public.gin_trgm_ops');
  }
  fs.writeFileSync(path.join(phase4MigrationDir, migration), contents);
  if (migrationNumber < 20) {
    fs.writeFileSync(path.join(previousHeadMigrationDir, migration), contents);
  }
}

function newSchemaName() {
  const name = `migration_probe_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  schemas.add(name);
  return name;
}

async function createSchema(name) {
  await db.query(`CREATE SCHEMA "${name}"`);
}

async function resetPgBossSchema() {
  await db.query('DROP SCHEMA IF EXISTS pgboss CASCADE');
}

async function dropSchema(name) {
  await db.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
  schemas.delete(name);
}

async function withSchemaClient(schema, callback) {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${schema}", public`);
    return await callback(client);
  } finally {
    client.release();
    await pool.end();
  }
}

async function insertPhase4Fixture(client) {
  const city = await client.query("INSERT INTO cities (name) VALUES ('phase4 test city') RETURNING id");
  const cityId = city.rows[0].id;
  const users = await client.query(
    `INSERT INTO users (phone, password_hash, full_name)
     VALUES ('+923000000101', 'test-hash', 'Phase 4 Seller'),
            ('+923000000102', 'test-hash', 'Phase 4 Buyer'),
            ('+923000000103', 'test-hash', 'Phase 4 Admin')
     RETURNING id, phone`
  );
  const userIds = Object.fromEntries(users.rows.map((row) => [row.phone, row.id]));
  const category = await client.query("INSERT INTO main_categories (name) VALUES ('Phase 4') RETURNING id");
  const subcategory = await client.query(
    "INSERT INTO sub_categories (main_category_id, name) VALUES ($1, 'Phase 4') RETURNING id",
    [category.rows[0].id]
  );
  const listing = await client.query(
    `INSERT INTO listings (seller_id, main_category_id, sub_category_id, condition, title, asking_price)
     VALUES ($1, $2, $3, 'brand_new', 'Phase 4 Listing', 1000)
     RETURNING id`,
    [userIds['+923000000101'], category.rows[0].id, subcategory.rows[0].id]
  );
  return {
    cityId,
    sellerId: userIds['+923000000101'],
    buyerId: userIds['+923000000102'],
    adminId: userIds['+923000000103'],
    listingId: listing.rows[0].id,
  };
}

async function insertReservation(client, fixture, overrides = {}) {
  const values = {
    listingId: fixture.listingId,
    buyerId: fixture.buyerId,
    sellerId: fixture.sellerId,
    status: 'active',
    itemPrice: '100.00',
    deliveryFee: '10.00',
    total: '110.00',
    currency: 'PKR',
    cityId: fixture.cityId,
    ...overrides,
  };
  const result = await client.query(
    `INSERT INTO reservations (
       listing_id, buyer_id, seller_id, status, item_price_snapshot,
       delivery_fee_snapshot, total_amount_snapshot, currency, recipient_name,
       recipient_phone, city_id, address_line1, address_line2, postal_code, expires_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, 'Test Recipient', '+923000000102',
       $9, 'Test address', NULL, NULL, now() + INTERVAL '60 minutes'
     ) RETURNING id`,
    [
      values.listingId,
      values.buyerId,
      values.sellerId,
      values.status,
      values.itemPrice,
      values.deliveryFee,
      values.total,
      values.currency,
      values.cityId,
    ]
  );
  return result.rows[0].id;
}

async function insertOffer(client, fixture) {
  const conversation = await client.query(
    `INSERT INTO conversations (listing_id, buyer_id, seller_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [fixture.listingId, fixture.buyerId, fixture.sellerId]
  );
  const offer = await client.query(
    `INSERT INTO offers (conversation_id, listing_id, proposed_by, amount, status)
     VALUES ($1, $2, $3, 100, 'accepted') RETURNING id`,
    [conversation.rows[0].id, fixture.listingId, fixture.buyerId]
  );
  return offer.rows[0].id;
}

afterEach(async () => {
  for (const schema of [...schemas]) await dropSchema(schema);
});

afterAll(() => {
  fs.rmSync(applicationMigrationDir, { recursive: true, force: true });
  fs.rmSync(authMigrationDir, { recursive: true, force: true });
  fs.rmSync(phase4MigrationDir, { recursive: true, force: true });
  fs.rmSync(previousHeadMigrationDir, { recursive: true, force: true });
});

describe('FR-79b PostgreSQL migration runner', () => {
  test('FR-84: the auth foundation migration creates sessions, factor, reset, and code tables', async () => {
    const schema = newSchemaName();
    const applied = await runMigrations({ databaseUrl, schema, migrationsDir: authMigrationDir });
    expect(applied).toHaveLength(4);
    const { rows } = await db.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = ANY($2::text[]) ORDER BY table_name`,
      [schema, ['auth_sessions', 'email_login_codes', 'password_reset_tokens', 'staff_totp_credentials']]
    );
    expect(rows.map((row) => row.table_name)).toEqual([
      'auth_sessions', 'email_login_codes', 'password_reset_tokens', 'staff_totp_credentials',
    ]);
    const columns = await db.query(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
      [schema, 'users']
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(expect.arrayContaining([
      'email_verified_at', 'password_changed_at',
    ]));
    const codeColumns = await db.query(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
      [schema, 'email_login_codes']
    );
    expect(codeColumns.rows.map((row) => row.column_name)).toContain('purpose');
    const totpColumns = await db.query(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
      [schema, 'staff_totp_credentials']
    );
    expect(totpColumns.rows.map((row) => row.column_name)).toContain('last_used_step');
  });

  test('fresh schema applies its ordered migration once and is idempotent', async () => {
    const schema = newSchemaName();
    const first = await runMigrations({ databaseUrl, schema, migrationsDir: applicationMigrationDir });
    const second = await runMigrations({ databaseUrl, schema, migrationsDir: applicationMigrationDir });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    const { rows } = await db.query(`SELECT count(*)::int AS count FROM "${schema}".schema_migrations`);
    expect(rows[0].count).toBe(1);
  });

  test('existing compatible schema can be baselined without changing application data', async () => {
    const schema = newSchemaName();
    await createSchema(schema);
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO "${schema}", public`);
        await client.query(initialSchema);
        await client.query("INSERT INTO cities (name) VALUES ('migration baseline preservation probe')");
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }

    await expect(runMigrations({ databaseUrl, schema, migrationsDir: applicationMigrationDir })).rejects.toThrow(/explicit db:migrate:baseline/);
    await runMigrations({ databaseUrl, schema, migrationsDir: applicationMigrationDir, baselineExisting: true });
    const { rows } = await db.query(`SELECT name FROM "${schema}".cities`);
    expect(rows).toEqual([{ name: 'migration baseline preservation probe' }]);
    const history = await db.query(`SELECT name FROM "${schema}".schema_migrations`);
    expect(history.rows).toEqual([{ name: '001_initial_schema' }]);
  });

  test('unrecognized existing schema is refused without changing its rows', async () => {
    const schema = newSchemaName();
    await createSchema(schema);
    await db.query(`CREATE TABLE "${schema}".keep_me (value text)`);
    await db.query(`INSERT INTO "${schema}".keep_me VALUES ('untouched')`);

    await expect(runMigrations({ databaseUrl, schema, migrationsDir: applicationMigrationDir, baselineExisting: true }))
      .rejects.toThrow(/does not match the initial migration/);
    const { rows } = await db.query(`SELECT value FROM "${schema}".keep_me`);
    expect(rows).toEqual([{ value: 'untouched' }]);
    const history = await db.query(
      "SELECT to_regclass($1) AS history", [`${schema}.schema_migrations`]
    );
    expect(history.rows[0].history).toBeNull();
  });

  test('failed migration rolls back and can be retried after the migration is corrected', async () => {
    const schema = newSchemaName();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poshaak-migration-retry-'));
    const migrationPath = path.join(dir, '001_retry.sql');
    try {
      await createSchema(schema);
      fs.writeFileSync(migrationPath, 'CREATE TABLE retry_probe (id integer); SELECT 1 / 0;');
      let migrationError;
      try {
        await runMigrations({ databaseUrl, schema, migrationsDir: dir });
      } catch (error) {
        migrationError = error;
      }
      expect(migrationError).toEqual(expect.objectContaining({
        message: expect.stringMatching(/division by zero/i),
        code: '22012',
      }));

      const afterFailure = await db.query(
        "SELECT to_regclass($1) AS relation", [`${schema}.retry_probe`]
      );
      expect(afterFailure.rows[0].relation).toBeNull();
      const historyAfterFailure = await db.query(
        `SELECT name FROM "${schema}".schema_migrations WHERE name = $1`, ['001_retry']
      );
      expect(historyAfterFailure.rows).toEqual([]);

      fs.writeFileSync(migrationPath, 'CREATE TABLE retry_probe (id integer);');
      await expect(runMigrations({ databaseUrl, schema, migrationsDir: dir })).resolves.toHaveLength(1);
      const afterRetry = await db.query(`SELECT to_regclass($1) AS relation`, [`${schema}.retry_probe`]);
      expect(afterRetry.rows[0].relation).not.toBeNull();
      const historyAfterRetry = await db.query(
        `SELECT name FROM "${schema}".schema_migrations WHERE name = $1`, ['001_retry']
      );
      expect(historyAfterRetry.rows).toEqual([{ name: '001_retry' }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('concurrent migration runners serialize and record the initial migration once', async () => {
    const schema = newSchemaName();
    const results = await Promise.all([
      runMigrations({ databaseUrl, schema, migrationsDir: applicationMigrationDir }),
      runMigrations({ databaseUrl, schema, migrationsDir: applicationMigrationDir }),
    ]);
    const { rows } = await db.query(`SELECT count(*)::int AS count FROM "${schema}".schema_migrations`);
    expect(rows[0].count).toBe(1);
    expect(results.flat()).toHaveLength(1);
  });

  test('FR-79b: a fresh database applies the Phase 4 schema in one migration run', async () => {
    const schema = newSchemaName();
    await resetPgBossSchema();
    const applied = await runMigrations({ databaseUrl, schema, migrationsDir: phase4MigrationDir });
    expect(applied).toHaveLength(19);

    const relations = await db.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = ANY($2::text[]) ORDER BY table_name`,
      [schema, [
        'reservations', 'supported_delivery_cities', 'payments', 'refunds', 'ledger_entries',
        'webhook_inbox', 'money_audit_events',
      ]]
    );
    expect(relations.rows.map((row) => row.table_name)).toEqual([
      'ledger_entries', 'money_audit_events', 'payments', 'refunds', 'reservations',
      'supported_delivery_cities', 'webhook_inbox',
    ]);

    const columns = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'orders'`,
      [schema]
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(expect.arrayContaining([
      'reservation_id', 'funded_at', 'handover_deadline_at', 'handed_over_at',
      'courier_pickup_at', 'handover_recorded_at',
    ]));

    const enumLabels = await db.query(
      `SELECT e.enumlabel
       FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = $1 AND t.typname = 'order_status'`,
      [schema]
    );
    expect(enumLabels.rows.map((row) => row.enumlabel)).toEqual(expect.arrayContaining([
      'reserved', 'payment_pending', 'funded',
    ]));
  });

  test('FR-79b: migration preserves legacy COD rows and legacy order inserts', async () => {
    const schema = newSchemaName();
    await resetPgBossSchema();
    await runMigrations({ databaseUrl, schema, migrationsDir: previousHeadMigrationDir });

    let fixture;
    let offerId;
    let legacyOrderIds;
    await withSchemaClient(schema, async (client) => {
      fixture = await insertPhase4Fixture(client);
      offerId = await insertOffer(client, fixture);
      const orders = [];
      for (const status of ['bag', 'order_placed', 'held']) {
        const order = await client.query(
          `INSERT INTO orders (
             accepted_offer_id, listing_id, buyer_id, seller_id, agreed_item_price,
             delivery_fee, delivery_address, payment_method_preference, status
           ) VALUES ($1, $2, $3, $4, 100, 5, 'legacy address', 'cash', $5)
           RETURNING id`,
          [offerId, fixture.listingId, fixture.buyerId, fixture.sellerId, status]
        );
        orders.push(order.rows[0].id);
      }
      await client.query(
        'INSERT INTO cod_collections (order_id, collected_amount, collection_method) VALUES ($1, 105, $2)',
        [orders[0], 'cash']
      );
      await client.query(
        "INSERT INTO payout_holds (order_id, hold_started_at, state) VALUES ($1, now(), 'held')",
        [orders[2]]
      );
      legacyOrderIds = orders;
    });

    const applied = await runMigrations({ databaseUrl, schema, migrationsDir: phase4MigrationDir });
    expect(applied).toHaveLength(1);

    await withSchemaClient(schema, async (client) => {
      const preservedOrders = await client.query(
        `SELECT id, status::text, accepted_offer_id, agreed_item_price, delivery_fee, total_cod_amount
         FROM orders WHERE id = ANY($1::uuid[])`,
        [legacyOrderIds]
      );
      expect(preservedOrders.rows).toHaveLength(3);
      expect(preservedOrders.rows.map((row) => row.status).sort()).toEqual(['bag', 'held', 'order_placed']);
      expect(preservedOrders.rows.every((row) => row.accepted_offer_id)).toBe(true);
      expect(preservedOrders.rows.every((row) => row.total_cod_amount === '105.00')).toBe(true);
      await expect(client.query(
        'SELECT order_id FROM cod_collections WHERE order_id = $1',
        [legacyOrderIds[0]]
      )).resolves.toMatchObject({ rows: [{ order_id: legacyOrderIds[0] }] });
      await expect(client.query(
        'SELECT order_id FROM payout_holds WHERE order_id = $1',
        [legacyOrderIds[2]]
      )).resolves.toMatchObject({ rows: [{ order_id: legacyOrderIds[2] }] });

      const insertedLegacyOrder = await client.query(
        `INSERT INTO orders (
           accepted_offer_id, listing_id, buyer_id, seller_id, agreed_item_price,
           delivery_fee, delivery_address, payment_method_preference, status
         ) VALUES ($1, $2, $3, $4, 100, 5, 'legacy address', 'cash', 'bag')
         RETURNING id, total_cod_amount`,
        [offerId, fixture.listingId, fixture.buyerId, fixture.sellerId]
      );
      expect(insertedLegacyOrder.rows[0].total_cod_amount).toBe('105.00');
    });
  });

  test('FR-63a and SEC-34: reservation and order amount constraints protect snapshots', async () => {
    const schema = newSchemaName();
    await resetPgBossSchema();
    await runMigrations({ databaseUrl, schema, migrationsDir: phase4MigrationDir });
    await withSchemaClient(schema, async (client) => {
      const fixture = await insertPhase4Fixture(client);
      const reservationId = await insertReservation(client, fixture);

      await expect(insertReservation(client, fixture)).rejects.toMatchObject({ code: '23505' });
      await expect(insertReservation(client, fixture, { status: 'expired', itemPrice: '0' }))
        .rejects.toMatchObject({ code: '23514' });
      await expect(insertReservation(client, fixture, { status: 'expired', total: '111' }))
        .rejects.toMatchObject({ code: '23514' });

      await expect(client.query(
        `INSERT INTO orders (
           reservation_id, listing_id, buyer_id, seller_id, agreed_item_price,
           delivery_fee, delivery_address, payment_method_preference
         ) VALUES ($1, $2, $3, $4, 99, 10, '[reservation snapshot]', 'fixed_price_gateway')`,
        [reservationId, fixture.listingId, fixture.buyerId, fixture.sellerId]
      )).rejects.toMatchObject({ code: '23514' });

      const order = await client.query(
        `INSERT INTO orders (
           reservation_id, listing_id, buyer_id, seller_id, agreed_item_price,
           delivery_fee, delivery_address, payment_method_preference
         ) VALUES ($1, $2, $3, $4, 100, 10, '[reservation snapshot]', 'fixed_price_gateway')
         RETURNING id`,
        [reservationId, fixture.listingId, fixture.buyerId, fixture.sellerId]
      );
      expect(order.rows[0].id).toBeDefined();

      await expect(client.query(
        'UPDATE reservations SET address_line1 = $2 WHERE id = $1',
        [reservationId, 'Changed address']
      )).rejects.toMatchObject({ code: '23514' });

      await expect(client.query(
        `UPDATE orders
         SET funded_at = now(), handover_deadline_at = now() + INTERVAL '71 hours'
         WHERE id = $1`,
        [order.rows[0].id]
      )).rejects.toMatchObject({ code: '23514' });
    });
  });

  test('SEC-33, SEC-34 and SEC-39: payment, webhook and refund uniqueness constraints hold', async () => {
    const schema = newSchemaName();
    await resetPgBossSchema();
    await runMigrations({ databaseUrl, schema, migrationsDir: phase4MigrationDir });
    await withSchemaClient(schema, async (client) => {
      const fixture = await insertPhase4Fixture(client);
      const reservationId = await insertReservation(client, fixture);
      const order = await client.query(
        `INSERT INTO orders (
           reservation_id, listing_id, buyer_id, seller_id, agreed_item_price,
           delivery_fee, delivery_address, payment_method_preference
         ) VALUES ($1, $2, $3, $4, 100, 10, '[reservation snapshot]', 'fixed_price_gateway')
         RETURNING id`,
        [reservationId, fixture.listingId, fixture.buyerId, fixture.sellerId]
      );
      const orderId = order.rows[0].id;
      const payment = await client.query(
        `INSERT INTO payments (order_id, provider, status, amount, currency, gateway_fee_currency, idempotency_key)
         VALUES ($1, 'test', 'succeeded', 110, 'PKR', 'PKR', 'payment-key-1')
         RETURNING id`,
        [orderId]
      );
      const paymentId = payment.rows[0].id;

      await expect(client.query(
        `INSERT INTO payments (order_id, provider, status, amount, currency, gateway_fee_currency, idempotency_key)
         VALUES ($1, 'test', 'failed', 110, 'PKR', 'PKR', 'payment-key-1')`,
        [orderId]
      )).rejects.toMatchObject({ code: '23505' });
      await expect(client.query(
        `INSERT INTO payments (order_id, provider, status, amount, currency, gateway_fee_currency, idempotency_key)
         VALUES ($1, 'test', 'succeeded', 110, 'PKR', 'PKR', 'payment-key-2')`,
        [orderId]
      )).rejects.toMatchObject({ code: '23505' });

      const inboxValues = [
        'test', 'event-1', 'payment.succeeded', Buffer.from('{}'), JSON.stringify({ verified: true }),
        JSON.stringify({ received: true }), paymentId,
      ];
      await client.query(
        `INSERT INTO webhook_inbox (
           provider, provider_event_id, event_type, raw_body, signature_metadata,
           timestamp_metadata, verified_at, status, payment_id
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, now(), 'received', $7)`,
        inboxValues
      );
      await expect(client.query(
        `INSERT INTO webhook_inbox (
           provider, provider_event_id, event_type, raw_body, signature_metadata,
           timestamp_metadata, verified_at, status, payment_id
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, now(), 'received', $7)`,
        inboxValues
      )).rejects.toMatchObject({ code: '23505' });

      await expect(client.query(
        `INSERT INTO refunds (
           payment_id, order_id, trigger, amount, currency, status, idempotency_key,
           requested_by, approved_by
         ) VALUES ($1, $2, 'manual_admin', 110, 'PKR', 'approved', 'refund-key-1', $3, $3)`,
        [paymentId, orderId, fixture.adminId]
      )).rejects.toMatchObject({ code: '23514' });
      await expect(client.query(
        `INSERT INTO refunds (
           payment_id, order_id, trigger, amount, currency, status, idempotency_key
         ) VALUES ($1, $2, 'system_cancel', 0, 'PKR', 'pending', 'refund-key-zero')`,
        [paymentId, orderId]
      )).rejects.toMatchObject({ code: '23514' });

      await client.query(
        `INSERT INTO refunds (
           payment_id, order_id, trigger, amount, currency, status, idempotency_key,
           requested_by, approved_by
         ) VALUES ($1, $2, 'manual_admin', 110, 'PKR', 'approved', 'refund-key-2', $3, $4)`,
        [paymentId, orderId, fixture.adminId, fixture.buyerId]
      );
      await expect(client.query(
        `INSERT INTO refunds (
           payment_id, order_id, trigger, amount, currency, status, idempotency_key
         ) VALUES ($1, $2, 'system_expiry', 110, 'PKR', 'pending', 'refund-key-2')`,
        [paymentId, orderId]
      )).rejects.toMatchObject({ code: '23505' });
    });
  });

  test('FR-79f and SEC-34: ledger and money audit records reject update, delete, and truncate', async () => {
    const schema = newSchemaName();
    await resetPgBossSchema();
    await runMigrations({ databaseUrl, schema, migrationsDir: phase4MigrationDir });
    await withSchemaClient(schema, async (client) => {
      const fixture = await insertPhase4Fixture(client);
      const ledger = await client.query(
        `INSERT INTO ledger_entries (currency, amount, entry_type, idempotency_key)
         VALUES ('PKR', 10, 'capture', 'ledger-key-1') RETURNING id`
      );
      await expect(client.query(
        `INSERT INTO ledger_entries (currency, amount, entry_type, idempotency_key)
         VALUES ('PKR', 10, 'capture', 'ledger-key-1')`
      )).rejects.toMatchObject({ code: '23505' });
      const audit = await client.query(
        `INSERT INTO money_audit_events (actor_id, action)
         VALUES ($1, 'payment.capture') RETURNING id`,
        [fixture.adminId]
      );

      await expect(client.query(
        'UPDATE ledger_entries SET amount = 11 WHERE id = $1', [ledger.rows[0].id]
      )).rejects.toMatchObject({ code: '55000' });
      await expect(client.query(
        'DELETE FROM ledger_entries WHERE id = $1', [ledger.rows[0].id]
      )).rejects.toMatchObject({ code: '55000' });
      await expect(client.query('TRUNCATE ledger_entries')).rejects.toMatchObject({ code: '55000' });
      await expect(client.query(
        'UPDATE money_audit_events SET action = $2 WHERE id = $1', [audit.rows[0].id, 'changed']
      )).rejects.toMatchObject({ code: '55000' });
      await expect(client.query(
        'DELETE FROM money_audit_events WHERE id = $1', [audit.rows[0].id]
      )).rejects.toMatchObject({ code: '55000' });
      await expect(client.query('TRUNCATE money_audit_events')).rejects.toMatchObject({ code: '55000' });
    });
  });
});
