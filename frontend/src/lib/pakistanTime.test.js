import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PAKISTAN_TIME_ZONE, formatPakistanDateTime, formatPakistanDate } from './pakistanTime.js'

test('FR-79g: frontend and backend produce the same Pakistan-time string', () => {
  assert.equal(PAKISTAN_TIME_ZONE, 'Asia/Karachi')
  const fixtures = [
    ['2026-11-26T10:45:00Z', '26 Nov 2026, 3:45 PM PKT'],
    ['2026-11-26T18:45:00Z', '26 Nov 2026, 11:45 PM PKT'],
    ['2026-11-26T19:30:00Z', '27 Nov 2026, 12:30 AM PKT'],
    ['2026-11-05T07:00:00Z', '5 Nov 2026, 12:00 PM PKT'],
  ]
  fixtures.forEach(([instant, expected]) => assert.equal(formatPakistanDateTime(instant), expected))
  assert.equal(formatPakistanDate('2026-11-26T10:45:00Z'), '26 Nov 2026')
  assert.equal(formatPakistanDate('2026-11-26'), '26 Nov 2026')
})

test('FR-79g: frontend output is invariant across process timezone', () => {
  const previous = process.env.TZ
  const output = []
  for (const timezone of ['America/Los_Angeles', 'Pacific/Pago_Pago', 'UTC']) {
    process.env.TZ = timezone
    output.push(formatPakistanDateTime('2026-11-26T10:45:00Z'))
  }
  if (previous === undefined) delete process.env.TZ
  else process.env.TZ = previous
  assert.deepEqual(output, ['26 Nov 2026, 3:45 PM PKT', '26 Nov 2026, 3:45 PM PKT', '26 Nov 2026, 3:45 PM PKT'])
})

test('FR-79g: frontend formatter bans en-PK, undefined locale and toLocale calls', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, 'pakistanTime.js'), 'utf8')
  assert.doesNotMatch(source, /'en-PK'|"en-PK"|Intl\.DateTimeFormat\(\s*(?:undefined|null)/)
  assert.doesNotMatch(source, /toLocale(?:Date)?(?:Time)?String|toLocaleString/)
})
