/**
 * Enforces rules.md Section 6, part 1: every exported function in
 * modules/*.service.js has a comment DIRECTLY above its declaration that
 * cites at least one FR code (e.g. "FR-45f"). Strict by decision: helpers
 * that don't map to one FR cite the FR they serve — there is no
 * "no FR" escape hatch.
 *
 * Static check, like no-circular-requires.test.js. "Directly above" means
 * the comment block ends on the line immediately before the function — a
 * "// ---- FR-xx ----" section header separated by a blank line does not
 * count.
 */

const fs = require('fs');
const path = require('path');

const MODULES_DIR = path.join(__dirname, '..', '..', 'src', 'modules');
const FR_PATTERN = /\bFR-\d+[a-z]?\b/;

function exportedNames(source) {
  const m = source.match(/module\.exports\s*=\s*\{([\s\S]*?)\};/);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.replace(/\/\/.*$/gm, '').trim())
    .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
}

/** The comment block ending on the line directly above `lineIdx`, or '' if none. */
function commentAbove(lines, lineIdx) {
  let i = lineIdx - 1;
  if (i < 0) return '';
  const block = [];
  if (lines[i].trim().endsWith('*/')) {
    while (i >= 0) {
      block.unshift(lines[i]);
      if (lines[i].trim().startsWith('/*')) break;
      i -= 1;
    }
  } else {
    while (i >= 0 && lines[i].trim().startsWith('//')) {
      block.unshift(lines[i]);
      i -= 1;
    }
  }
  return block.join('\n');
}

const cases = [];
for (const file of fs.readdirSync(MODULES_DIR).filter((f) => f.endsWith('.service.js'))) {
  const lines = fs.readFileSync(path.join(MODULES_DIR, file), 'utf8').split('\n');
  const source = lines.join('\n');
  for (const name of exportedNames(source)) {
    const idx = lines.findIndex((l) => new RegExp(`^(async\\s+)?function\\s+${name}\\s*\\(`).test(l));
    if (idx === -1) continue; // exported constant, not a function
    cases.push({ file, name, comment: commentAbove(lines, idx) });
  }
}

describe('rules.md Section 6: every exported service function cites an FR code', () => {
  test('the scan actually found the exported functions (guards against silently checking nothing)', () => {
    expect(cases.length).toBeGreaterThanOrEqual(80);
  });

  test.each(cases)('$file → $name() has an FR code in the comment directly above it', ({ comment }) => {
    expect(comment).toMatch(FR_PATTERN);
  });
});
