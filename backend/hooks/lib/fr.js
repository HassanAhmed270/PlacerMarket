/**
 * hooks/lib/fr.js
 *
 * Pure functions shared by the git hooks (hooks/commit-msg, hooks/pre-commit)
 * and the Jest suite (test/unit/specs-checkboxes.test.js, test/unit/git-hooks.test.js).
 * Kept free of git/fs calls so they can be unit-tested directly — the hook
 * scripts are thin wrappers that gather inputs from git and call these.
 */

const TITLE_LINE = /\b(?:describe|test|it)(?:\.each\([^)]*\))?\(\s*(['"`])(.*?)\1/;
const ROW = /^\s*- \[([ xX])\]\s+\**(FR-\d+[a-z]?)\b(.*)$/;

/** Every describe/test/it title string in a test file's source. Titles only — comments never count. */
function extractTitles(source) {
  return source.split('\n').map((l) => (l.match(TITLE_LINE) || [])[2]).filter(Boolean);
}

/**
 * Rows ticked [x] in specs.md text. `isOpen` is true when the row still carries a tag that blocks ticking:
 * (OPEN ...), (DISCUSS ...) or (SUPERSEDED ...) — including forms like "(OPEN / MAJOR GAP)". The name is
 * kept for compatibility. (DEFERRED) is not blocking: some in-scope rows carry a deferred sub-note.
 */
function tickedRows(specsText) {
  return specsText.split('\n')
    .map((line) => line.match(ROW))
    .filter((m) => m && m[1] !== ' ')
    .map((m) => ({ code: m[2], isOpen: /\((OPEN|DISCUSS|SUPERSEDED)\b/.test(m[3]) }));
}

/** Every FR code that has a checkbox row (ticked or not) in specs.md text. */
function allCodes(specsText) {
  return new Set(specsText.split('\n').map((l) => l.match(ROW)).filter(Boolean).map((m) => m[2]));
}

/** True if some title names `code` in full (FR-45 is NOT satisfied by a title that only says FR-45a). */
function namesFr(titles, code) {
  const re = new RegExp(`\\b${code}\\b`);
  return titles.some((t) => re.test(t));
}

/** FR codes ticked in `stagedSpecs` that were not already ticked in `headSpecs`. */
function newlyTicked(headSpecs, stagedSpecs) {
  const before = new Set(tickedRows(headSpecs || '').map((r) => r.code));
  return tickedRows(stagedSpecs).map((r) => r.code).filter((c) => !before.has(c));
}

/**
 * Pre-commit rule (rules.md Section 8, part 3): every FR ticked by this
 * commit must have a test, staged in the SAME commit, whose title names it.
 * @returns {string[]} newly ticked FR codes that lack such a test
 */
function findUnbackedTicks({ headSpecs, stagedSpecs, stagedTestSources }) {
  const titles = stagedTestSources.flatMap(extractTitles);
  return newlyTicked(headSpecs, stagedSpecs).filter((code) => !namesFr(titles, code));
}

/**
 * Commit-msg rule (rules.md Section 8, part 2):
 *   "<FR-code(s)>: <description>"   e.g. "FR-45a, FR-50a: add guard"
 *   "chore: <description>"  |  "docs: <description>"
 * Git-generated "Merge ..." subjects pass. If `knownCodes` is given, every
 * FR code in the message must exist in specs.md (catches typos like FR-4a5).
 * @returns {{ok: boolean, reason?: string}}
 */
function validateCommitMessage(raw, knownCodes) {
  const subject = raw.split('\n').map((l) => l.trimEnd()).find((l) => l.trim() && !l.startsWith('#'));
  if (!subject) return { ok: false, reason: 'the commit message is empty' };
  if (/^Merge /.test(subject)) return { ok: true };

  const m = subject.match(/^(FR-\d+[a-z]?(?:\s*,\s*FR-\d+[a-z]?)*|chore|docs): (\S.*)$/);
  if (!m) {
    return { ok: false, reason: 'subject must be "<FR-code(s)>: <description>", "chore: <description>" or "docs: <description>"' };
  }
  if (knownCodes && m[1].startsWith('FR-')) {
    const unknown = m[1].split(/\s*,\s*/).filter((c) => !knownCodes.has(c));
    if (unknown.length) return { ok: false, reason: `not an FR code in specs.md: ${unknown.join(', ')}` };
  }
  return { ok: true };
}

/** Staged paths that must never be committed (rules.md Section 8, part 4) — catches `git add -f`. */
function forbiddenStagedPaths(paths) {
  return paths.filter((p) => /(^|\/)node_modules\//.test(p) || /(^|\/)\.env$/.test(p) || /(^|\/)coverage\//.test(p));
}

module.exports = {
  extractTitles, tickedRows, allCodes, namesFr, newlyTicked,
  findUnbackedTicks, validateCommitMessage, forbiddenStagedPaths,
};
