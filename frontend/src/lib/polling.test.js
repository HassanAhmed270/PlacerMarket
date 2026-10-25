import assert from 'node:assert/strict'
import { test } from 'node:test'
import { POLL_INTERVALS, schedulePolling } from './polling.js'

test('chat and inbox polling use the decision intervals', () => {
  assert.equal(POLL_INTERVALS.openChat, 15_000)
  assert.equal(POLL_INTERVALS.inbox, 60_000)
  assert.equal(POLL_INTERVALS.unread, 60_000)
})

test('polling cleanup clears the scheduled timer', () => {
  let callback
  let interval
  let cleared
  const stop = schedulePolling(() => {}, 15_000, {
    setIntervalImpl: (fn, delay) => {
      callback = fn
      interval = delay
      return 42
    },
    clearIntervalImpl: (timer) => { cleared = timer },
  })
  assert.equal(typeof callback, 'function')
  assert.equal(interval, 15_000)
  stop()
  assert.equal(cleared, 42)
})
