const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('FR-69: the additional-Admin command refuses piped stdin without exposing input', () => {
  const pipedInput = 'noninteractive-input-probe';
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, '../../scripts/create-additional-admin.js')],
    {
      cwd: path.join(__dirname, '../..'),
      input: pipedInput,
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    }
  );
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  expect(result.status).not.toBe(0);
  expect(output.toLowerCase().includes('interactive terminal')).toBe(true);
  expect(output.includes(pipedInput)).toBe(false);
});
