const { Pool } = require('pg');
const catalog = require('../../src/modules/catalog.service');
const settlement = require('../../src/modules/settlement.service');

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe('real PostgreSQL baseline', () => {
  test('schema.sql creates exactly the 36 tables through listing revisions', async () => {
    const pool = new Pool({ connectionString: testDatabaseUrl });
    try {
      const { rows } = await pool.query(
        "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
      );
      expect(rows[0].count).toBe(36);
    } finally {
      await pool.end();
    }
  });

  test('seed.js inserts five platform settings, including the 30 percent instant price decrease limit', async () => {
    const pool = require('../../src/db.service').pool;
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM platform_settings');
    expect(rows[0].count).toBe(5);
    await expect(settlement.getSetting('commission_percent')).resolves.toBe('10');
    await expect(settlement.getSetting('instant_price_decrease_max_percent')).resolves.toBe('30');
  });

  test('catalog.createMainCategory and listMainCategories round-trip through PostgreSQL', async () => {
    const categoryName = `Integration ${Date.now()}`;
    const created = await catalog.createMainCategory({ name: categoryName });
    const found = await catalog.listMainCategories();
    expect(found).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id, name: categoryName })]));
  });
});
