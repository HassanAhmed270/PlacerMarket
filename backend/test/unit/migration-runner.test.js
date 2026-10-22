const fs = require('fs');
const path = require('path');
const { parseInitialSchema } = require('../../db/migrate');
const { migrationFiles, upSection, generateSnapshot } = require('../../db/generate-schema-snapshot');

describe('FR-79b migration support', () => {
  test('schema compatibility parser identifies tables, columns, and enum labels without treating constraints as columns', () => {
    const parsed = parseInitialSchema(`
      CREATE TYPE sample_status AS ENUM ('draft', 'published');
      CREATE TABLE sample (
        id UUID PRIMARY KEY,
        title TEXT NOT NULL,
        CONSTRAINT title_unique UNIQUE (title),
        CHECK (length(title) > 0)
      );
    `);
    expect(parsed.tables.get('sample')).toEqual(['id', 'title']);
    expect(parsed.enums.get('sample_status')).toEqual(['draft', 'published']);
  });

  test('snapshot generator orders numbered SQL migrations and includes only each up section', () => {
    expect(migrationFiles()).toEqual([
      '001_initial_schema.sql', '002_pgboss_schema.sql', '003_auth_foundation.sql',
      '004_email_code_purpose.sql',
      '005_staff_totp_replay_guard.sql',
        '006_measurement_field_lifecycle.sql', '007_payout_encryption_envelope.sql',
        '008_manual_identity_verification.sql',
    ]);
    expect(upSection('-- Up Migration\nCREATE TABLE x (id int);\n-- Down Migration\nDROP TABLE x;', 'sample.sql'))
      .toBe('CREATE TABLE x (id int);');
    expect(generateSnapshot()).toBe(fs.readFileSync(path.join(__dirname, '..', '..', 'schema.sql'), 'utf8'));
  });
});
