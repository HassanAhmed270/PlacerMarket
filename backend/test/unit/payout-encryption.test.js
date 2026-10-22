const { createKeyProvider } = require('../../src/lib/keyProvider');
const { encryptPayoutDetails, decryptPayoutDetails } = require('../../src/lib/payoutEncryption');

function provider(activeKeyId, entries) {
  return createKeyProvider({ activeKeyId, keys: new Map(entries.map(([id, byte]) => [id, Buffer.alloc(32, byte)])) });
}

describe('FR-79f: versioned payout encryption', () => {
  test('uses AES-GCM with random nonces, key IDs and seller-bound authenticated data', () => {
    const keys = provider('key-a', [['key-a', 1]]);
    const details = { method: 'bank', iban: 'PK00EXAMPLE1234' };
    const first = encryptPayoutDetails(details, 'seller-a', keys);
    const second = encryptPayoutDetails(details, 'seller-a', keys);
    expect(first).toMatchObject({ version: 1, algorithm: 'aes-256-gcm', keyId: 'key-a' });
    expect(first.nonce).not.toBe(second.nonce);
    expect(JSON.stringify(first)).not.toContain('PK00EXAMPLE1234');
    expect(decryptPayoutDetails(first, 'seller-a', keys)).toEqual(details);
    expect(() => decryptPayoutDetails(first, 'seller-b', keys)).toThrow();
  });

  test('rotates mixed key versions by decrypting old records and re-encrypting with the active key', async () => {
    const oldKeys = provider('key-old', [['key-old', 2], ['key-new', 3]]);
    const newKeys = provider('key-new', [['key-old', 2], ['key-new', 3]]);
    const rowA = { user_id: '00000000-0000-4000-8000-000000000001', payout_details_encrypted: encryptPayoutDetails({ holder: 'A' }, '00000000-0000-4000-8000-000000000001', oldKeys), payout_bank_account: null, payout_wallet_number: null, payout_last4: null };
    const rowB = { user_id: '00000000-0000-4000-8000-000000000002', payout_details_encrypted: encryptPayoutDetails({ holder: 'B' }, '00000000-0000-4000-8000-000000000002', newKeys), payout_bank_account: null, payout_wallet_number: null, payout_last4: null };
    const rows = [rowA, rowB];
    const database = { query: jest.fn(async (sql, params) => {
      if (sql.includes('SELECT')) return { rows: rows.filter((row) => row.user_id > params[0]).slice(0, params[1]) };
      const row = rows.find((item) => item.user_id === params[0]);
      if (row && (params[4] === null ? row.payout_details_encrypted === null : JSON.stringify(row.payout_details_encrypted) === params[4])) {
        row.payout_details_encrypted = JSON.parse(params[1]);
      }
      return { rowCount: 1 };
    }) };
    const { rotate } = require('../../scripts/rotate-payout-keys');
    await expect(rotate({ database, keyProvider: newKeys, batchSize: 1 })).resolves.toBe(1);
    expect(rowA.payout_details_encrypted.keyId).toBe('key-new');
    expect(rowB.payout_details_encrypted.keyId).toBe('key-new');
    expect(decryptPayoutDetails(rowA.payout_details_encrypted, rowA.user_id, newKeys)).toEqual({ holder: 'A' });
    expect(decryptPayoutDetails(rowB.payout_details_encrypted, rowB.user_id, newKeys)).toEqual({ holder: 'B' });
  });

  test('FR-79f/SEC-30: key rotation encrypts and scrubs legacy plaintext columns', async () => {
    const keys = provider('key-new', [['key-new', 3]]);
    const row = {
      user_id: '00000000-0000-4000-8000-000000000003', payout_details_encrypted: null,
      payout_bank_account: 'PK00BANK0000000000001234', payout_wallet_number: null,
      payout_last4: null, payout_needs_update: false,
    };
    const database = { query: jest.fn(async (sql, params) => {
      if (sql.includes('SELECT')) return { rows: row.user_id > params[0] ? [row] : [] };
      if (row.user_id === params[0] && row.payout_details_encrypted === params[4] && row.payout_bank_account === params[5]) {
        row.payout_details_encrypted = JSON.parse(params[1]);
        row.payout_last4 = row.payout_last4 || params[2];
        row.payout_needs_update ||= params[3];
        row.payout_bank_account = null;
        row.payout_wallet_number = null;
        return { rowCount: 1 };
      }
      return { rowCount: 0 };
    }) };
    const { rotate } = require('../../scripts/rotate-payout-keys');
    await expect(rotate({ database, keyProvider: keys })).resolves.toBe(1);
    expect(row.payout_bank_account).toBeNull();
    expect(row.payout_last4).toBe('1234');
    expect(row.payout_needs_update).toBe(true);
    expect(decryptPayoutDetails(row.payout_details_encrypted, row.user_id, keys)).toMatchObject({
      legacyMigrated: true, legacyBankAccount: 'PK00BANK0000000000001234',
    });
  });
});
