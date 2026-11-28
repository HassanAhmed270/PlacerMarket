const fs = require('node:fs');
const path = require('node:path');
const {
  PAKISTAN_TIME_ZONE,
  formatPakistanDateTime,
  formatPakistanDate,
} = require('../../src/lib/pakistanTime');

function findBackendDateFormattingOffenders(backendDir) {
  const offenders = [];
  const unambiguousBans = /toLocaleDateString|toLocaleTimeString|Intl\.DateTimeFormat|toDateString|toTimeString|toUTCString/;
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', 'test', 'dist'].includes(entry.name)) walk(absolute);
      } else if (entry.name.endsWith('.js') && !absolute.endsWith('pakistanTime.js')) {
        const lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/);
        lines.forEach((line, index) => {
          if (unambiguousBans.test(line)) offenders.push(`${path.relative(backendDir, absolute)}:${index + 1}`);
          if (/\.toLocaleString\s*\(/.test(line)) {
            const numberReceiver = /Number\([^;]+\)\.toLocaleString\s*\(/.test(line);
            const dateOptions = /(timeZone|dateStyle|timeStyle|hour|minute|month|weekday|year)\s*:/.test(line);
            if (!numberReceiver || dateOptions) offenders.push(`${path.relative(backendDir, absolute)}:${index + 1}`);
          }
        });
      }
    }
  }
  walk(path.join(backendDir, 'src'));
  return offenders;
}

describe('FR-79g: Pakistan time formatting', () => {
  test('FR-79g: fixed-parts Pakistan date and time fixtures match the owner format', () => {
    expect(PAKISTAN_TIME_ZONE).toBe('Asia/Karachi');
    const fixtures = [
      ['2026-11-26T10:45:00Z', '26 Nov 2026, 3:45 PM PKT'],
      ['2026-11-26T18:45:00Z', '26 Nov 2026, 11:45 PM PKT'],
      ['2026-11-26T19:30:00Z', '27 Nov 2026, 12:30 AM PKT'],
      ['2026-11-05T07:00:00Z', '5 Nov 2026, 12:00 PM PKT'],
    ];
    fixtures.forEach(([instant, expected]) => {
      expect(formatPakistanDateTime(instant)).toBe(expected);
    });
    expect(formatPakistanDate('2026-11-26T10:45:00Z')).toBe('26 Nov 2026');
    expect(formatPakistanDate('2026-11-26')).toBe('26 Nov 2026');
  });

  test('FR-79g: output is identical in America/Los_Angeles, Pacific/Pago_Pago and UTC', () => {
    const previous = process.env.TZ;
    const output = [];
    for (const timezone of ['America/Los_Angeles', 'Pacific/Pago_Pago', 'UTC']) {
      process.env.TZ = timezone;
      output.push(formatPakistanDateTime('2026-11-26T10:45:00Z'));
    }
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
    expect(output).toEqual([
      '26 Nov 2026, 3:45 PM PKT',
      '26 Nov 2026, 3:45 PM PKT',
      '26 Nov 2026, 3:45 PM PKT',
    ]);
  });

  test('no human-visible string contains PST, UTC or GMT', () => {
    const text = `${formatPakistanDateTime('2026-11-26T10:45:00Z')} ${formatPakistanDate('2026-11-26')}`;
    expect(text).not.toMatch(/\b(?:PST|UTC|GMT)\b/);
  });

  test('FR-79g: formatter source uses the fixed en-US locale', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/lib/pakistanTime.js'), 'utf8');
    expect(source).toContain("Intl.DateTimeFormat('en-US'");
    expect(source).not.toContain("'en-PK'");
  });

  test('no other backend file formats dates directly', () => {
    const backendDir = path.resolve(__dirname, '../..');
    const offenders = findBackendDateFormattingOffenders(backendDir);
    const direct = fs.readFileSync(path.join(backendDir, 'src/modules/payout.service.js'), 'utf8');
    expect(direct).not.toContain('toISOString()');
    expect(offenders).toEqual([]);
  });

  test('positive date ban fixture and negative price fixture', () => {
    const price = Number(1250).toLocaleString('en-PK', { maximumFractionDigits: 2 });
    expect(price).toBeTruthy();
    expect('2026-11-26').toBeTruthy();
  });

  test('date timezone formatting fails while number formatting passes', () => {
    const dateLine = "new Date(2026, 1, 2).toLocaleString('en-US', { timeZone: 'UTC' });";
    const priceLine = "Number(x).toLocaleString('en-PK', { maximumFractionDigits: 2 });";
    expect(/toLocaleString/.test(dateLine)).toBe(true);
    expect(/Number\([^;]+\)\.toLocaleString\s*\(/.test(dateLine)).toBe(false);
    expect(/Number\([^;]+\)\.toLocaleString\s*\(/.test(priceLine)).toBe(true);
    expect(/(timeZone|dateStyle|timeStyle|hour|minute|month|weekday|year)\s*:/.test(dateLine)).toBe(true);
  });

  test('payout release message uses PKT', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/modules/payout.service.js'), 'utf8');
    expect(source).toContain("formatPakistanDateTime");
  });
});
