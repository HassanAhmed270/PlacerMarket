/**
 * db/seed.js
 *
 * Seeds the `platform_settings` rows that settlement.service.getSetting()
 * is expected to find. Without these, a large chunk of the service layer
 * throws NotFoundError on first use:
 *   - users.service.isIdVerificationRequired()   needs high_value_threshold_pkr (FR-08a)
 *   - listingRevisions.service.js applies instant_price_decrease_max_percent (FR-73e)
 *   - disputes.service.fileDispute()              needs complaint_window_days (FR-43)
 *   - payout.service.startHold()                  needs payout_hold_days, complaint_window_days (FR-45c)
 *   - settlement.service.calculateCommission()     needs commission_percent (FR-46)
 *
 * Values below are the provisional defaults schema.sql itself suggests in
 * its "seeded rows (examples, not migrations)" comment under MODULE 10 —
 * change them via settlement.service.setSetting() / the admin fee-config
 * route once real values are decided, not by editing this file repeatedly.
 *
 * Usage: npm run db:seed
 */

const { Pool } = require('pg');

const SEED_SETTINGS = [
  ['commission_percent', '10'], // FR-46
  ['high_value_threshold_pkr', '100000'], // FR-08a / FR-19b
  ['instant_price_decrease_max_percent', '30'], // FR-73e
  ['payout_hold_days', '5'], // FR-45c
  ['complaint_window_days', '3'], // FR-43
  ['reservation_minutes', '60'], // Phase 4
  ['max_unpaid_reservations', '3'], // Phase 4
  ['delivery_fee_pkr', '300'], // Phase 4
  ['handover_deadline_hours', '72'], // Phase 4
];

async function seed() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    for (const [key, value] of SEED_SETTINGS) {
      await pool.query(
        `INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        [key, value]
      );
    }
    // eslint-disable-next-line no-console
    console.log('platform_settings seeded:', SEED_SETTINGS.map(([k]) => k).join(', '));
  } finally {
    await pool.end();
  }
}

seed().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Seed failed:', err.message);
  process.exit(1);
});
