/**
 * Unit tests for the pure logic behind hooks/commit-msg and hooks/pre-commit
 * (hooks/lib/fr.js). NOTE: titles here deliberately name no FR code — the
 * checkbox check in specs-checkboxes.test.js scans test titles, and example
 * codes in THIS file's titles would falsely satisfy it. Codes appear only in
 * test bodies.
 */
const {
  validateCommitMessage, findUnbackedTicks, forbiddenStagedPaths, newlyTicked, allCodes, tickedRows,
} = require('../../hooks/lib/fr');
const path = require('path');
const { findProjectRoot, relativeGitPath } = require('../../hooks/lib/project-root');

const specs = (rows) => rows.map(([mark, code, rest = 'Some requirement.']) => `- [${mark}] ${code} ${rest}`).join('\n');

describe('commit-msg format (rules.md Section 8, part 2)', () => {
  const known = new Set(['FR-13', 'FR-45a', 'FR-50a']);

  test.each([
    'FR-13: add condition types',
    'FR-45a, FR-50a: add partial-refund guard to dispute resolution',
    'FR-45a,FR-50a: comma without a space is tolerated',
    'chore: bump jest',
    'docs: clarify rules.md',
    'Merge branch main into feature',
    'FR-13: subject line\n\nlonger body paragraph that is not validated',
    '# a comment line first\nFR-13: real subject after a comment',
  ])('accepts %j', (msg) => {
    expect(validateCommitMessage(msg, known).ok).toBe(true);
  });

  test.each([
    ['', 'empty'],
    ['# only a comment', 'empty'],
    ['fixed a bug', 'no prefix'],
    ['fr-13: lowercase prefix', 'lowercase'],
    ['FR-13 missing colon', 'no colon'],
    ['FR-13:no space after colon', 'no space'],
    ['FR-13: ', 'empty description'],
    ['feat: not an allowed type', 'type not allowed'],
    ['FR-13 FR-45a: no comma between codes', 'no comma'],
  ])('rejects %j (%s)', (msg) => {
    expect(validateCommitMessage(msg, known).ok).toBe(false);
  });

  test('rejects an FR code that does not exist in specs.md, and names it', () => {
    const r = validateCommitMessage('FR-9999: typo in the code', known);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('FR-9999');
  });

  test('skips the existence check when no known-codes set is given', () => {
    expect(validateCommitMessage('FR-9999: no specs.md available').ok).toBe(true);
  });
});

describe('a ticked checkbox needs a test in the same commit (rules.md Section 8, part 3)', () => {
  const head = specs([[' ', 'FR-13'], [' ', 'FR-45a'], [' ', 'FR-45']]);
  const testSource = (title) => `describe('${title}', () => { test('x', () => {}); });`;

  test('allows a newly ticked row when a staged test title names it', () => {
    const staged = specs([['x', 'FR-13'], [' ', 'FR-45a'], [' ', 'FR-45']]);
    expect(findUnbackedTicks({ headSpecs: head, stagedSpecs: staged, stagedTestSources: [testSource('FR-13: types are fixed')] })).toEqual([]);
  });

  test('flags a newly ticked row with no staged test', () => {
    const staged = specs([['x', 'FR-13'], [' ', 'FR-45a'], [' ', 'FR-45']]);
    expect(findUnbackedTicks({ headSpecs: head, stagedSpecs: staged, stagedTestSources: [] })).toEqual(['FR-13']);
  });

  test('a mention in a comment or helper does not count — titles only', () => {
    const staged = specs([['x', 'FR-13'], [' ', 'FR-45a'], [' ', 'FR-45']]);
    const sneaky = `// covers FR-13\nconst helper = 'FR-13';\ntest('unrelated', () => {});`;
    expect(findUnbackedTicks({ headSpecs: head, stagedSpecs: staged, stagedTestSources: [sneaky] })).toEqual(['FR-13']);
  });

  test('a test that only names the longer code does not back the shorter one', () => {
    const staged = specs([[' ', 'FR-13'], [' ', 'FR-45a'], ['x', 'FR-45']]);
    expect(findUnbackedTicks({ headSpecs: head, stagedSpecs: staged, stagedTestSources: [testSource('FR-45a: guard')] })).toEqual(['FR-45']);
  });

  test('rows already ticked before this commit are not re-checked', () => {
    const before = specs([['x', 'FR-13'], [' ', 'FR-45a'], [' ', 'FR-45']]);
    expect(findUnbackedTicks({ headSpecs: before, stagedSpecs: before, stagedTestSources: [] })).toEqual([]);
  });

  test('unticking a row is not a problem', () => {
    const before = specs([['x', 'FR-13']]);
    const after = specs([[' ', 'FR-13']]);
    expect(findUnbackedTicks({ headSpecs: before, stagedSpecs: after, stagedTestSources: [] })).toEqual([]);
  });

  test('on a first commit (no HEAD specs) every ticked row needs a test', () => {
    expect(newlyTicked('', specs([['x', 'FR-13'], ['x', 'FR-45a']]))).toEqual(['FR-13', 'FR-45a']);
  });

  test('the legend line mentioning [x] is not mistaken for a ticked row', () => {
    const legend = '**Legend:** `[ ]` = not done · `[x]` = done';
    expect(newlyTicked('', `${legend}\n${specs([[' ', 'FR-13']])}`)).toEqual([]);
    expect([...allCodes(`${legend}\n${specs([[' ', 'FR-13']])}`)]).toEqual(['FR-13']);
  });
});

describe('never-commit paths (rules.md Section 8, part 4)', () => {
  test('flags node_modules, .env and coverage anywhere in the tree', () => {
    expect(forbiddenStagedPaths([
      'src/app.js', 'node_modules/x/index.js', 'sub/node_modules/y.js', '.env', 'config/.env', 'coverage/lcov.info',
    ])).toEqual(['node_modules/x/index.js', 'sub/node_modules/y.js', '.env', 'config/.env', 'coverage/lcov.info']);
  });

  test('allows .env.example and look-alike names', () => {
    expect(forbiddenStagedPaths(['.env.example', 'src/environment.js', 'docs/coverage-notes.md'])).toEqual([]);
  });
});

describe('hook project-root resolution', () => {
  test('finds the backend requirements from a repository root and computes Git paths', () => {
    const repositoryRoot = path.resolve(__dirname, '..', '..', '..');
    const projectRoot = findProjectRoot(repositoryRoot);
    expect(projectRoot).toBe(path.join(repositoryRoot, 'backend'));
    expect(relativeGitPath(repositoryRoot, path.join(projectRoot, 'specs.md'))).toBe('backend/specs.md');
  });
});

describe('rows that must not be ticked yet (blocking tags)', () => {
  test.each([
    '- [x] FR-01 **(OPEN)** plain open item',
    '- [x] FR-02 **(OPEN / MAJOR GAP)** open item with a longer tag',
    '- [x] FR-03 **(OPEN: duration not decided)** open item with a reason',
    '- [x] FR-04 **(DISCUSS)** proposed, not confirmed by the human',
    '- [x] FR-05 **(SUPERSEDED by escrow — see FR-60)** replaced by a later decision',
  ])('flags %j as not tickable', (row) => {
    expect(tickedRows(row)[0].isOpen).toBe(true);
  });

  test.each([
    '- [x] FR-06 an untagged row',
    '- [x] FR-07 a row with a deferred sub-note **(DEFERRED: real-time courier API)**',
    '- [x] FR-08 text that mentions an open question in prose, with no tag',
  ])('does not flag %j', (row) => {
    expect(tickedRows(row)[0].isOpen).toBe(false);
  });

  test('an unticked blocked row is simply not reported as ticked', () => {
    expect(tickedRows('- [ ] FR-09 **(DISCUSS)** not ticked')).toEqual([]);
  });
});
