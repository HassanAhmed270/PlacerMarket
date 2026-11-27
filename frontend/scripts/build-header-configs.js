import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = JSON.parse(fs.readFileSync(path.join(frontendDir, 'security-headers.json'), 'utf8'));

const headers = Object.entries(policy)
  .filter(([name]) => name !== 'csp')
  .map(([name, value]) => ({ key: name, value }));
headers.unshift({ key: 'Content-Security-Policy', value: policy.csp });

const vercel = [
  {
    source: '/(.*)',
    headers,
  },
];

const nginx = headers
  .map(({ key, value }) => `add_header ${key} "${value.replace(/"/g, '\\"')}" always;`)
  .join('\n');

if (process.argv.includes('--check')) {
  const vercelPath = path.join(frontendDir, 'vercel.json');
  const nginxPath = path.join(frontendDir, 'deploy', 'nginx-security-headers.conf.example');
  if (fs.readFileSync(vercelPath, 'utf8').trim() !== `${JSON.stringify(vercel, null, 2)}\n`.trim()) process.exitCode = 1;
  if (fs.readFileSync(nginxPath, 'utf8').trim() !== nginx.trim()) process.exitCode = 1;
} else {
  fs.mkdirSync(path.join(frontendDir, 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(frontendDir, 'vercel.json'), `${JSON.stringify(vercel, null, 2)}\n`);
  fs.writeFileSync(path.join(frontendDir, 'deploy', 'nginx-security-headers.conf.example'), `${nginx}\n`);
}
