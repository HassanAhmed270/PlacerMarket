const db = require('../src/db.service');
const { keyProviderFromEnv } = require('../src/lib/keyProvider');
const { decryptPayoutDetails, encryptPayoutDetails } = require('../src/lib/payoutEncryption');

async function rotate({ database = db, keyProvider = keyProviderFromEnv(), batchSize = 100 } = {}) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new TypeError('batchSize must be between 1 and 1000.');
  let lastId = '';
  let rotated = 0;
  for (;;) {
    const { rows } = await database.query(
      `SELECT user_id, payout_details_encrypted
         FROM seller_profiles
        WHERE payout_details_encrypted IS NOT NULL AND user_id::text > $1
        ORDER BY user_id::text LIMIT $2`, [lastId, batchSize]
    );
    if (rows.length === 0) return rotated;
    for (const row of rows) {
      lastId = row.user_id;
      const envelope = row.payout_details_encrypted;
      if (envelope.keyId === keyProvider.activeKeyId) continue;
      const details = decryptPayoutDetails(envelope, row.user_id, keyProvider);
      const replacement = encryptPayoutDetails(details, row.user_id, keyProvider);
      await database.query(
        `UPDATE seller_profiles SET payout_details_encrypted = $2::jsonb
          WHERE user_id = $1 AND payout_details_encrypted = $3::jsonb`,
        [row.user_id, JSON.stringify(replacement), JSON.stringify(envelope)]
      );
      rotated += 1;
    }
  }
}

if (require.main === module) {
  rotate().then((count) => {
    // eslint-disable-next-line no-console
    console.log(`Payout key rotation completed; records re-encrypted: ${count}.`);
  }).catch((error) => {
    // eslint-disable-next-line no-console
    console.error(`Payout key rotation failed: ${error.message}`);
    process.exitCode = 1;
  }).finally(() => db.pool.end());
}

module.exports = { rotate };
