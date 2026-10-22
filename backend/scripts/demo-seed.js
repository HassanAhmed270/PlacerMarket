const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const demoEnvPath = path.join(__dirname, '..', '.demo.env');
if (fs.existsSync(demoEnvPath) && typeof process.loadEnvFile === 'function') process.loadEnvFile(demoEnvPath);

function requireDevelopmentTarget(env = process.env) {
  if (env.NODE_ENV === 'production' || env.DEV_FAKES !== '1') {
    throw new Error('demo:seed requires non-production DEV_FAKES=1.');
  }
  if (!env.DEMO_DATABASE_URL) throw new Error('Set DEMO_DATABASE_URL to a local development database before demo:seed.');
  const url = new URL(env.DEMO_DATABASE_URL);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
      !/(?:demo|dev|local)/i.test(databaseName) || /testing_only|test/i.test(databaseName)) {
    throw new Error('demo:seed only accepts a localhost database whose name includes demo, dev, or local (never testing_only).');
  }
  return env.DEMO_DATABASE_URL;
}

function secret(name, bytes = 32) {
  const existing = process.env[name];
  return typeof existing === 'string' && existing.length >= bytes && !/CHANGE_ME|EXAMPLE|REPLACE/i.test(existing)
    ? existing : randomBytes(bytes).toString('base64url');
}

function payoutKeyConfiguration() {
  try {
    const activeKeyId = process.env.PAYOUT_ENCRYPTION_ACTIVE_KEY_ID;
    const keys = JSON.parse(process.env.PAYOUT_ENCRYPTION_KEYS_JSON);
    if (typeof activeKeyId === 'string' && Buffer.from(keys[activeKeyId] || '', 'base64').length === 32) {
      return { activeKeyId, keysJson: JSON.stringify(keys) };
    }
  } catch { /* A new local demo key is generated below. */ }
  return { activeKeyId: 'demo-v1', keysJson: JSON.stringify({ 'demo-v1': randomBytes(32).toString('base64') }) };
}

async function main() {
  const databaseUrl = requireDevelopmentTarget();
  const adminEmail = process.env.DEMO_ADMIN_EMAIL || 'demo-admin@poshaak.local';
  const adminPassword = secret('DEMO_ADMIN_PASSWORD', 24);
  const adminTotpSecret = process.env.DEMO_ADMIN_TOTP_SECRET || require('../src/lib/totp').generateTotpSecret();
  const candidateEmail = process.env.DEMO_CANDIDATE_EMAIL || 'demo-seller-candidate@poshaak.local';
  const candidatePassword = secret('DEMO_CANDIDATE_PASSWORD', 24);
  const payoutKeys = payoutKeyConfiguration();
  const generated = {
    DEMO_DATABASE_URL: databaseUrl,
    DATABASE_URL: databaseUrl,
    DEMO_ADMIN_EMAIL: adminEmail,
    DEMO_ADMIN_PASSWORD: adminPassword,
    DEMO_ADMIN_TOTP_SECRET: adminTotpSecret,
    DEMO_CANDIDATE_EMAIL: candidateEmail,
    DEMO_CANDIDATE_PASSWORD: candidatePassword,
    NODE_ENV: 'development',
    DEV_FAKES: '1',
    CHALLENGE_VERIFIER_ADAPTER: 'fake',
    EMAIL_CODE_RESEND_SECONDS: '1',
    CORS_ORIGINS: 'http://127.0.0.1:5173,http://localhost:5173',
    PORT: process.env.PORT || '3000',
    REDIS_URL: process.env.REDIS_URL && !/CHANGE_ME|EXAMPLE/i.test(process.env.REDIS_URL) ? process.env.REDIS_URL : 'redis://127.0.0.1:6379',
    JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET', 48),
    EMAIL_QUEUE_ENCRYPTION_SECRET: secret('EMAIL_QUEUE_ENCRYPTION_SECRET', 48),
    STAFF_TOTP_ENCRYPTION_SECRET: secret('STAFF_TOTP_ENCRYPTION_SECRET', 48),
    PAYOUT_ENCRYPTION_ACTIVE_KEY_ID: payoutKeys.activeKeyId,
    PAYOUT_ENCRYPTION_KEYS_JSON: payoutKeys.keysJson,
  };
  fs.writeFileSync(demoEnvPath, `${Object.entries(generated).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n')}\n`, { mode: 0o600 });
  Object.assign(process.env, generated);

  const db = require('../src/db.service');
  const { hashPassword, passwordHashPool } = require('../src/lib/passwordHashPool');
  const users = require('../src/modules/users.service');
  const { generateTotpCode } = require('../src/lib/totp');
  try {
    const { rows: admins } = await db.query("SELECT id FROM users WHERE role = 'admin'");
    if (admins.length) throw new Error('A database administrator already exists. Run demo:seed only on a clean local demo database.');
    const { rows: cityRows } = await db.query(
      `INSERT INTO cities (name, is_active) VALUES ('Lahore Demo', true)
       ON CONFLICT (name) DO UPDATE SET is_active = true RETURNING id`
    );
    const { rows: categoryRows } = await db.query(
      `INSERT INTO main_categories (name) VALUES ('Women Demo')
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`
    );
    const { rows: subCategoryRows } = await db.query(
      `INSERT INTO sub_categories (main_category_id, name, is_active) VALUES ($1, 'Formal Demo', true)
       ON CONFLICT (main_category_id, name) DO UPDATE SET is_active = true RETURNING id`, [categoryRows[0].id]
    );
    await db.query(
      `INSERT INTO measurement_field_defs (sub_category_id, field_name, unit, display_order, required, is_active)
       VALUES ($1, 'chest demo', 'inches', 1, true, true)
       ON CONFLICT (sub_category_id, field_name) DO UPDATE SET required = true, is_active = true`, [subCategoryRows[0].id]
    );

    const { rows: candidateRows } = await db.query('SELECT id FROM users WHERE email = $1', [candidateEmail]);
    if (!candidateRows[0]) {
      const candidateHash = await hashPassword(candidatePassword);
      await db.query(
        `INSERT INTO users (full_name, phone, email, password_hash, city_id, role, email_verified_at)
         VALUES ('Demo Seller Candidate', $1, $2, $3, $4, 'buyer', now())`,
        [`+1888${Date.now().toString().slice(-9)}`, candidateEmail, candidateHash, cityRows[0].id]
      );
    }

    await users.createInitialAdmin({
      name: 'Poshaak Demo Admin', email: adminEmail, phone: '+18885550100',
      password: adminPassword, totpSecret: adminTotpSecret, totpCode: generateTotpCode(adminTotpSecret),
    });
    // Do not print the credentials or verification secret: they are in the local ignored demo environment file.
    console.log('Demo data seeded in the guarded local development database. Admin and candidate credentials are stored in backend/.demo.env.');
    console.log(`Demo city: ${cityRows[0].id}; category: ${categoryRows[0].id}; subcategory: ${subCategoryRows[0].id}.`);
  } finally {
    await passwordHashPool.close();
    await db.pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Demo seed failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { requireDevelopmentTarget };
