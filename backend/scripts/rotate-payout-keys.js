const db = require('../src/db.service');
const { keyProviderFromEnv } = require('../src/lib/keyProvider');
const { decryptPayoutDetails, encryptPayoutDetails } = require('../src/lib/payoutEncryption');

async function rotate({ database = db, keyProvider = keyProviderFromEnv(), batchSize = 100 } = {}) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new TypeError('batchSize must be between 1 and 1000.');
  let lastId = '';
  let rotated = 0;
  for (;;) {
    const { rows } = await database.query(
      `SELECT user_id, payout_details_encrypted, payout_bank_account, payout_wallet_number, payout_last4
         FROM seller_profiles
        WHERE (payout_details_encrypted IS NOT NULL OR payout_bank_account IS NOT NULL OR payout_wallet_number IS NOT NULL)
          AND user_id::text > $1
        ORDER BY user_id::text LIMIT $2`, [lastId, batchSize]
    );
    if (rows.length === 0) return rotated;
    for (const row of rows) {
      lastId = row.user_id;
      const envelope = row.payout_details_encrypted;
      const hasLegacy = row.payout_bank_account !== null || row.payout_wallet_number !== null;
      if (!hasLegacy && envelope.keyId === keyProvider.activeKeyId) continue;
      const details = envelope ? decryptPayoutDetails(envelope, row.user_id, keyProvider) : {};
      if (hasLegacy) {
        details.legacyMigrated = true;
        if (row.payout_bank_account !== null) details.legacyBankAccount = row.payout_bank_account;
        if (row.payout_wallet_number !== null) details.legacyWalletNumber = row.payout_wallet_number;
      }
      const replacement = encryptPayoutDetails(details, row.user_id, keyProvider);
      const legacyValue = row.payout_wallet_number || row.payout_bank_account;
      const last4 = legacyValue ? String(legacyValue).replace(/\D/g, '').slice(-4) : null;
      await database.query(
        `UPDATE seller_profiles SET payout_details_encrypted = $2::jsonb,
            payout_last4 = COALESCE(payout_last4, $3), payout_needs_update = payout_needs_update OR $4,
            payout_bank_account = NULL, payout_wallet_number = NULL
          WHERE user_id = $1 AND payout_details_encrypted IS NOT DISTINCT FROM $5::jsonb
            AND payout_bank_account IS NOT DISTINCT FROM $6 AND payout_wallet_number IS NOT DISTINCT FROM $7`,
        [row.user_id, JSON.stringify(replacement), last4, hasLegacy, envelope ? JSON.stringify(envelope) : null,
          row.payout_bank_account, row.payout_wallet_number]
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
