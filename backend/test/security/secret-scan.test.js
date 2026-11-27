const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repositoryDir = path.resolve(__dirname, '../../..');
const allowlistPath = path.join(__dirname, 'secret-scan.allowlist.json');

const patterns = [
  ['PRIVATE_KEY_MARKER', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['AWS_ACCESS_KEY_ID', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['GITHUB_TOKEN', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['SLACK_TOKEN', /\bxox[baprs]-[A-Za-z0-9-]+\b/],
  ['STRIPE_TOKEN', /\b(?:sk|rk)_live_[A-Za-z0-9]+\b/],
  ['JWT_LIKE', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ['GENERIC_CREDENTIAL_ASSIGNMENT', /\b(?:password|passwd|password_hash|secret|token|api[_-]?key|authorization|cookie)\b\s*[:=]\s*['"`][^'"`]{6,}['"`]/i],
];

function gitTrackedTextFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repositoryDir })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((file) => {
      if (file.includes('node_modules') || file.includes('private-media')) return false;
      return !/\.(png|jpg|jpeg|gif|webp|ico|pdf|woff2?|ttf|otf)$/i.test(file);
    });
}

test('SEC-26: tracked text files contain no unexpected secrets or public VITE variables', () => {
  const allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
  const allowedHits = new Set((allowlist.genericHits || []).map((hit) => `${hit.path}:${hit.line}:${hit.type}`));
  const allowedVite = new Set(allowlist.vitePublicNames || []);
  const failures = [];

  for (const relative of gitTrackedTextFiles()) {
    const absolute = path.join(repositoryDir, relative);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    let text;
    try { text = fs.readFileSync(absolute, 'utf8'); } catch { continue; }
    text.split(/\r?\n/).forEach((line, index) => {
      for (const [type, regex] of patterns) {
        if (regex.test(line)) {
          const id = `${relative}:${index + 1}:${type}`;
          if (!allowedHits.has(id)) failures.push(`${type} ${relative}:${index + 1}`);
        }
      }
      if (/\bVITE_[A-Z0-9_]+\b/.test(line) && (
        /\bVITE_[A-Z0-9_]+\s*=/.test(line) ||
        /import\.meta\.env/.test(line)
      )) {
        for (const match of line.matchAll(/\b(VITE_[A-Z0-9_]+)\b/g)) {
          if (!allowedVite.has(match[1])) {
            failures.push(`UNEXPECTED_VITE_VARIABLE ${relative}:${index + 1}`);
          }
        }
      }
    });
  }

  expect(failures).toEqual([]);
});
