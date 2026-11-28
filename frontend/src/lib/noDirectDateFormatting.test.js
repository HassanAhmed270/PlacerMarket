import test from 'node:test'
import path from 'node:path'
import assert from 'node:assert/strict'
import { findDirectDateFormattingOffenders } from '../../scripts/date-format-scanner.js'

test('FR-79g: no frontend source directly formats human-visible dates', () => {
  const srcDir = path.resolve(import.meta.dirname, '..')
  assert.deepEqual(findDirectDateFormattingOffenders(srcDir), [])
})
