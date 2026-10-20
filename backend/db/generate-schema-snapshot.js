/** FR-79b: generate schema.sql from the ordered migration sources. */
const fs = require('fs');
const path = require('path');

const migrationsDir = path.join(__dirname, 'migrations');
const snapshotPath = path.join(__dirname, '..', 'schema.sql');

function migrationFiles() {
  return fs.readdirSync(migrationsDir)
    .filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file))
    .sort((left, right) => left.localeCompare(right, 'en'));
}

function upSection(sql, file) {
  const up = /^\s*--[\s-]*up\s+migration\s*$/im;
  const down = /^\s*--[\s-]*down\s+migration\s*$/im;
  const upMatch = up.exec(sql);
  const downMatch = down.exec(sql);
  if (downMatch && (!upMatch || downMatch.index < upMatch.index)) {
    throw new Error(`${file} has a down section before its up section`);
  }
  if (!upMatch) return sql.trim();
  const start = upMatch.index + upMatch[0].length;
  const end = downMatch ? downMatch.index : sql.length;
  return sql.slice(start, end).trim();
}

function generateSnapshot() {
  const files = migrationFiles();
  if (files.length === 0) throw new Error('No numbered SQL migrations found');
  const body = files.map((file) => {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    return `-- Migration: ${file}\n${upSection(sql, file)}`;
  }).join('\n\n');
  return `-- Generated from db/migrations by db:generate-schema. Do not edit directly.\n${body}\n`;
}

if (require.main === module) {
  const generated = generateSnapshot();
  const check = process.argv.includes('--check');
  if (check) {
    if (!fs.existsSync(snapshotPath) || fs.readFileSync(snapshotPath, 'utf8') !== generated) {
      console.error('schema.sql is not up to date; run npm run db:generate-schema');
      process.exitCode = 1;
    }
  } else {
    fs.writeFileSync(snapshotPath, generated);
    console.log('Generated schema.sql from ordered migrations.');
  }
}

module.exports = { migrationFiles, upSection, generateSnapshot };
