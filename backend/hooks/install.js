// Points git at the versioned hooks/ folder (hooks inside .git/ aren't versioned, so they'd never travel with the repo).
const { execFileSync } = require('child_process');
try {
  execFileSync('git', ['config', 'core.hooksPath', 'hooks'], { stdio: 'ignore' });
  console.log('git hooks installed (core.hooksPath = hooks)');
} catch (_) {
  console.log('git hooks not installed yet (not a git repository) — run `npm run hooks:install` after `git init`');
}
