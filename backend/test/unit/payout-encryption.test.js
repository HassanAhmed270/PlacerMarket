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
    const rowA = { user_id: '00000000-0000-4000-8000-000000000001', payout_details_encrypted: encryptPayoutDetails({ holder: 'A' }, '00000000-0000-4000-8000-000000000001', oldKeys) };
    const rowB = { user_id: '00000000-0000-4000-8000-000000000002', payout_details_encrypted: encryptPayoutDetails({ holder: 'B' }, '00000000-0000-4000-8000-000000000002', newKeys) };
    const rows = [rowA, rowB];
    const database = { query: jest.fn(async (sql, params) => {
      if (sql.includes('SELECT')) return { rows: rows.filter((row) => row.user_id > params[0]).slice(0, params[1]) };
      const row = rows.find((item) => item.user_id === params[0]);
      if (row && JSON.stringify(row.payout_details_encrypted) === params[2]) row.payout_details_encrypted = JSON.parse(params[1]);
      return { rowCount: 1 };
    }) };
    const { rotate } = require('../../scripts/rotate-payout-keys');
    await expect(rotate({ database, keyProvider: newKeys, batchSize: 1 })).resolves.toBe(1);
    expect(rowA.payout_details_encrypted.keyId).toBe('key-new');
    expect(rowB.payout_details_encrypted.keyId).toBe('key-new');
    expect(decryptPayoutDetails(rowA.payout_details_encrypted, rowA.user_id, newKeys)).toEqual({ holder: 'A' });
    expect(decryptPayoutDetails(rowB.payout_details_encrypted, rowB.user_id, newKeys)).toEqual({ holder: 'B' });
  });
});
