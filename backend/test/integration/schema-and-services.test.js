const { Pool } = require('pg');
const catalog = require('../../src/modules/catalog.service');
const settlement = require('../../src/modules/settlement.service');

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe('real PostgreSQL baseline', () => {
  test('schema.sql includes the existing tables and delivery-outcome structure', async () => {
    const pool = new Pool({ connectionString: testDatabaseUrl });
    try {
      const { rows } = await pool.query(
        "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
      );
      // Migration 040 adds review_reports and review_moderation_events.
      expect(rows[0].count).toBe(58);
    } finally {
      await pool.end();
    }
  });

  test('seed.js inserts existing and Phase 4 platform settings', async () => {
    const pool = require('../../src/db.service').pool;
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM platform_settings');
    // Migration 030 adds the payout threshold, 039 the dispute SLA, and 040 the review window setting.
    expect(rows[0].count).toBe(12);
    await expect(settlement.getSetting('commission_percent')).resolves.toBe('5');
    await expect(settlement.getSetting('instant_price_decrease_max_percent')).resolves.toBe('30');
    await expect(settlement.getSetting('reservation_minutes')).resolves.toBe('60');
    await expect(settlement.getSetting('max_unpaid_reservations')).resolves.toBe('3');
    await expect(settlement.getSetting('delivery_fee_pkr')).resolves.toBe('300');
    await expect(settlement.getSetting('handover_deadline_hours')).resolves.toBe('72');
  });

  test('catalog.createMainCategory and listMainCategories round-trip through PostgreSQL', async () => {
    const categoryName = `Integration ${Date.now()}`;
    const created = await catalog.createMainCategory({ name: categoryName });
    const found = await catalog.listMainCategories();
    expect(found).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id, name: categoryName })]));
  });
});
