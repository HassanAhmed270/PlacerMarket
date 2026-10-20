// Points git at the versioned hooks/ folder (hooks inside .git/ aren't versioned, so they'd never travel with the repo).
const { execFileSync } = require('child_process');
const path = require('path');
try {
  const repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const hooksPath = path.relative(repositoryRoot, __dirname).split(path.sep).join('/');
  execFileSync('git', ['config', 'core.hooksPath', hooksPath], { stdio: 'ignore' });
  console.log(`git hooks installed (core.hooksPath = ${hooksPath})`);
} catch (_) {
  console.log('git hooks not installed yet (not a git repository) — run `npm run hooks:install` after `git init`');
}
