const fs = require('fs');
const path = require('path');

function findProjectRoot(repositoryRoot) {
  if (fs.existsSync(path.join(repositoryRoot, 'specs.md'))) return repositoryRoot;
  const backendRoot = path.join(repositoryRoot, 'backend');
  if (fs.existsSync(path.join(backendRoot, 'specs.md'))) return backendRoot;
  return repositoryRoot;
}

function relativeGitPath(repositoryRoot, absolutePath) {
  return path.relative(repositoryRoot, absolutePath).split(path.sep).join('/');
}

module.exports = { findProjectRoot, relativeGitPath };
