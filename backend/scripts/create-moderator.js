
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const demoEnvPath = path.join(__dirname, '..', '.demo.env');

if (fs.existsSync(demoEnvPath) &&
    typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(demoEnvPath);
}
async function main() {
  const db = require('../src/db.service');
  const { hashPassword, passwordHashPool } =
    require('../src/lib/passwordHashPool');

  try {
    const email = 'moderator@gmail.com';
    const password = process.env.MODERATOR_PASSWORD;

    if (!password) {
      throw new Error('Set MODERATOR_PASSWORD first.');
    }

    const existing = await db.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );

    if (existing.rows.length) {
      throw new Error('Moderator email already exists.');
    }

    const passwordHash = await hashPassword(password);

    const phone = `+1888${randomBytes(4).readUInt32BE(0)
      .toString().padStart(10, '0').slice(-9)}`;

    const result = await db.query(
      `INSERT INTO users (
        full_name,
        phone,
        email,
        password_hash,
        role,
        can_review_listings,
        can_review_disputes,
        can_review_applications,
        is_suspended
      )
      VALUES ($1, $2, $3, $4, 'moderator', TRUE, TRUE, TRUE, FALSE)
      RETURNING id, full_name, email, role`,
      [
        'System Moderator',
        phone,
        email,
        passwordHash
      ]
    );

    console.log('Moderator created successfully:');
    console.log(result.rows[0]);

  } finally {
    await passwordHashPool.close();
    await db.pool.end();
  }
}

main().catch(error => {
  console.error('Moderator creation failed:', error.message);
  process.exitCode = 1;
});
