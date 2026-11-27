const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('SEC-32: frontend build contains no source maps or sourceMappingURL comments', () => {
  const frontendDir = path.resolve(__dirname, '../../../frontend');
  execFileSync(process.execPath, [path.join(frontendDir, 'node_modules/vite/bin/vite.js'), 'build'], {
    cwd: frontendDir,
    env: { ...process.env, NODE_ENV: '' },
    stdio: 'pipe',
  });
  const distDir = path.join(frontendDir, 'dist');
  if (process.env.SOURCE_MAP_MUTATION_TEST === '1') {
    fs.writeFileSync(path.join(distDir, 'mutation-proof.map'), '{}');
  }
  const mapFiles = [];
  const commentFiles = [];

  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name.endsWith('.map')) mapFiles.push(path.relative(distDir, absolute));
      else if (/\.(?:js|css)$/.test(entry.name)) {
        if (fs.readFileSync(absolute, 'utf8').includes('sourceMappingURL')) {
          commentFiles.push(path.relative(distDir, absolute));
        }
      }
    }
  }

  walk(distDir);
  expect(mapFiles).toEqual([]);
  expect(commentFiles).toEqual([]);
});
