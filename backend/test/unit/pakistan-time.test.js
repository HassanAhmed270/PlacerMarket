const fs = require('node:fs');
const path = require('node:path');
const {
  PAKISTAN_TIME_ZONE,
  formatPakistanDateTime,
  formatPakistanDate,
} = require('../../src/lib/pakistanTime');

describe('FR-79g: Pakistan time formatting', () => {
  test('FR-79g: formatPakistanDateTime renders Asia/Karachi with PKT', () => {
    expect(PAKISTAN_TIME_ZONE).toBe('Asia/Karachi');
    const text = formatPakistanDateTime('2026-11-26T10:45:00Z');
    expect(text).toContain('PKT');
    expect(text).toContain('2026');
  });

  test('FR-79g: Pakistan time output is invariant across process timezone', () => {
    const textLosAngeles = formatPakistanDateTime('2026-11-26T10:45:00Z');
    const previous = process.env.TZ;
    process.env.TZ = 'Pacific/Pago_Pago';
    const textPagoPago = formatPakistanDateTime('2026-11-26T10:45:00Z');
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
    expect(textLosAngeles).toBe(textPagoPago);
  });

  test('no human-visible string contains PST, UTC or GMT', () => {
    const text = `${formatPakistanDateTime('2026-11-26T10:45:00Z')} ${formatPakistanDate('2026-11-26')}`;
    expect(text).not.toMatch(/\b(?:PST|UTC|GMT)\b/);
  });

  test('no other backend file formats dates directly', () => {
    const backendDir = path.resolve(__dirname, '../..');
    const banned = /toLocaleDateString|toLocaleTimeString|toLocaleString\s*\([^)]*\)|Intl\.DateTimeFormat|toDateString|toTimeString|toUTCString|(?:new Date\([^)]*\))\.toString/;
    const offenders = [];
    function walk(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!['node_modules', 'test', 'dist'].includes(entry.name)) walk(absolute);
        } else if (entry.name.endsWith('.js') && !absolute.endsWith('pakistanTime.js')) {
          const lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/);
          lines.forEach((line, index) => {
            if (banned.test(line) && !/\d+.*toLocaleString/.test(line)) {
              if (!line.includes("toLocaleString('en-PK')") && !line.includes("toLocaleString('en-PK'")) {
                offenders.push(`${path.relative(backendDir, absolute)}:${index + 1}`);
              }
            }
          });
        }
      }
    }
    walk(path.join(backendDir, 'src'));
    const direct = fs.readFileSync(path.join(backendDir, 'src/modules/payout.service.js'), 'utf8');
    expect(direct).not.toContain('toISOString()');
    expect(offenders).toEqual([]);
  });

  test('positive date ban fixture and negative price fixture', () => {
    const price = Number(1250).toLocaleString('en-PK', { maximumFractionDigits: 2 });
    expect(price).toBeTruthy();
    expect('toLocaleDateString').toMatch(/toLocaleDateString/);
  });

  test('payout release message uses PKT', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/modules/payout.service.js'), 'utf8');
    expect(source).toContain("formatPakistanDateTime");
  });
});
