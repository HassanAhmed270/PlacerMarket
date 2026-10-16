/**
 * Enforces rules.md Section 1 (and Section 7): a specs.md checkbox may only
 * be ticked if (a) it carries no blocking tag — (OPEN ...), (DISCUSS ...) or (SUPERSEDED ...) — and (b) at least one test
 * has a describe/test/it TITLE that names that FR code. Titles only — a
 * mention in a comment or helper doesn't count, so a stray reference can't
 * satisfy the check.
 *
 * LIMIT, stated plainly: this can prove a test *names* the FR, not that the
 * test asserts the spec sentence. That part is a reviewer's job — the rule
 * (rules.md) says the test must assert the FR's actual behavior.
 */

const fs = require('fs');
const path = require('path');
const { extractTitles, tickedRows, namesFr } = require('../../hooks/lib/fr'); // same logic the pre-commit hook uses

const SPECS = path.join(__dirname, '..', '..', 'specs.md');
const TEST_ROOT = path.join(__dirname, '..');

function listTestFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listTestFiles(path.join(dir, e.name)) : e.name.endsWith('.test.js') && path.join(dir, e.name) !== __filename ? [path.join(dir, e.name)] : []
  );
}

// Titles across the suite, EXCLUDING this file — its own titles name FR codes as examples and must not satisfy the check.
const titles = listTestFiles(TEST_ROOT).flatMap((f) => extractTitles(fs.readFileSync(f, 'utf8')));
const ticked = tickedRows(fs.readFileSync(SPECS, 'utf8'));
const named = (code) => namesFr(titles, code);

describe('rules.md Section 1: ticked specs.md checkboxes are backed by a named test', () => {
  test('the title scan works (finds known FR-named tests; guards against checking against nothing)', () => {
    expect(titles.length).toBeGreaterThan(10);
    expect(named('FR-45a')).toBe(true);
    expect(named('FR-99z')).toBe(false);
  });

  test('FR-45 is not satisfied by a test that only names FR-45a (no prefix false-positive)', () => {
    expect(named('FR-45')).toBe(false);
  });

  if (ticked.length === 0) {
    test('no FR is ticked yet — nothing to check', () => expect(ticked).toEqual([]));
  } else {
    test.each(ticked)('ticked $code is not marked OPEN, DISCUSS or SUPERSEDED', ({ isOpen }) => {
      expect(isOpen).toBe(false);
    });
    test.each(ticked)('ticked $code has a test whose title names it', ({ code }) => {
      expect(named(code)).toBe(true);
    });
  }
});
