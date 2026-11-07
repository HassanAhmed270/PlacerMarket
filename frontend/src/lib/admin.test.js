import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  adminErrorMessage,
  adminHandoverErrorMessage,
  adminLoginErrorMessage,
  adminStatusLabel,
  buildAdminOrderQuery,
  formatAdminAmount,
  formatAdminDate,
  localDateTimeToIsoWithOffset,
  orderActionEligibility,
  payoutReleaseMessage,
  isRecordedHandoverConflict,
  validateDisputeResolution,
  validateExceptionResolutionNote,
  validateHandoverForm,
  validatePayoutForm,
} from './admin.js'

test('FR-72: handover form rejects future times, empty notes, and notes over 500 characters', () => {
  const now = Date.parse('2026-11-07T10:00:00.000Z')
  const base = {
    courierPickupAt: '2026-11-07T09:00:00.000Z',
    handoverConfirmationNote: 'Courier picked up the parcel',
    fundedAt: '2026-11-07T08:00:00.000Z',
  }
  assert.match(validateHandoverForm({ ...base, courierPickupAt: '2026-11-07T11:00:00.000Z' }, now), /future/)
  assert.match(validateHandoverForm({ ...base, handoverConfirmationNote: '' }, now), /3 to 500/)
  assert.match(validateHandoverForm({ ...base, handoverConfirmationNote: 'x'.repeat(501) }, now), /3 to 500/)
  assert.equal(validateHandoverForm(base, now), '')
})

test('FR-65: payout reference and note enforce backend length limits', () => {
  assert.match(validatePayoutForm({ payoutReference: 'ab', note: 'Valid payout note' }), /reference/)
  assert.match(validatePayoutForm({ payoutReference: 'Valid reference', note: 'x'.repeat(501) }), /note/)
  assert.equal(validatePayoutForm({ payoutReference: 'Valid reference', note: 'Manual transfer recorded' }), '')
})

test('FR-72e: exception resolution requires a trimmed 3 to 500 character note', () => {
  assert.match(validateExceptionResolutionNote('  '), /3 to 500/)
  assert.match(validateExceptionResolutionNote('x'.repeat(501)), /3 to 500/)
  assert.equal(validateExceptionResolutionNote('  Resolved with the courier  '), '')
})

test('Admin error mapping covers the API statuses and preserves 409/422 server messages', () => {
  const statuses = [400, 401, 403, 404, 409, 422, 429, 503]
  for (const status of statuses) {
    assert.ok(adminErrorMessage({ status }).length > 0)
  }
  assert.equal(adminErrorMessage({ status: 409, payload: { error: 'Order changed on the server.' } }), 'Order changed on the server.')
  assert.equal(adminErrorMessage({ status: 422, payload: { error: 'The note is invalid.' } }), 'The note is invalid.')
  assert.equal(adminErrorMessage({ status: 429 }), 'Too many requests, wait a moment.')
  assert.equal(adminLoginErrorMessage({ status: 401, payload: { error: 'Email or password is incorrect.' } }), 'Email or password is incorrect.')
  assert.equal(isRecordedHandoverConflict({ status: 409, payload: { error: 'The order was cancelled and refunded.' } }), true)
  assert.match(
    adminHandoverErrorMessage({ status: 409, payload: { error: 'The order was cancelled and refunded; it will not be reopened. An exception was recorded.' } }),
    /not reopened; an exception was recorded\. Resolve it under Exceptions/
  )
})

test('FR-68: order list query builder includes status and cursor without empty values', () => {
  assert.deepEqual(buildAdminOrderQuery(), { limit: 20 })
  assert.deepEqual(buildAdminOrderQuery({ status: 'funded', before: 'order-cursor' }), {
    limit: 20,
    status: 'funded',
    before: 'order-cursor',
  })
})

test('Admin helpers format server decimal strings and dates without money arithmetic', () => {
  assert.equal(formatAdminAmount('1200.50', 'PKR'), 'PKR 1200.50')
  assert.equal(formatAdminAmount('1200.50'), '1200.50')
  assert.match(formatAdminDate('2026-11-07T10:00:00.000Z', { timeZone: 'UTC' }), /2026/)
  assert.equal(formatAdminDate('invalid'), '—')
  assert.equal(adminStatusLabel('handed_to_delivery'), 'Handed to delivery')
  assert.equal(adminStatusLabel('dispute_refund_required'), 'Dispute refund required (manual)')
})

test('Admin order eligibility hints follow the order state and available permissions', () => {
  const handover = orderActionEligibility({
    status: 'funded',
    paymentStatus: 'succeeded',
    handoverDeadlineAt: '2026-11-08T10:00:00.000Z',
  }, { markHandover: true }, Date.parse('2026-11-07T10:00:00.000Z'))
  assert.equal(handover.handover.allowed, true)
  assert.equal(handover.delivered.allowed, false)
  const cancelledHandover = orderActionEligibility({
    status: 'cancelled',
    fundedAt: '2026-11-07T08:00:00.000Z',
    paymentStatus: 'succeeded',
    handoverDeadlineAt: '2026-11-08T10:00:00.000Z',
  }, { markHandover: true }, Date.parse('2026-11-07T10:00:00.000Z'))
  assert.equal(cancelledHandover.handover.allowed, true)

  const payout = orderActionEligibility({
    status: 'held',
    payoutHold: { state: 'held', earliestReleaseAt: '2026-11-08T10:00:00.000Z' },
  }, { releasePayout: true }, Date.parse('2026-11-07T10:00:00.000Z'))
  assert.equal(payout.payout.allowed, false)
  assert.match(payout.payout.hint, /Can be released after/)
  assert.match(payoutReleaseMessage({ earliestReleaseAt: '2026-11-08T10:00:00.000Z' }, Date.parse('2026-11-07T10:00:00.000Z')), /Can be released after/)
  assert.match(payoutReleaseMessage({ earliestReleaseAt: '2026-11-06T10:00:00.000Z' }, Date.parse('2026-11-07T10:00:00.000Z')), /can be released now/)
})

test('Admin datetime-local values become ISO timestamps with their local offset', () => {
  assert.equal(localDateTimeToIsoWithOffset('2026-11-07T10:15', 300), '2026-11-07T10:15:00-05:00')
  assert.equal(localDateTimeToIsoWithOffset('invalid', 0), '')
})

test('Admin helpers do not write to the console', () => {
  const originalLog = console.log
  const originalError = console.error
  const calls = []
  console.log = (...args) => calls.push(args)
  console.error = (...args) => calls.push(args)
  try {
    buildAdminOrderQuery({ status: 'funded' })
    validatePayoutForm({ payoutReference: 'abc', note: 'note' })
    adminErrorMessage({ status: 400 })
  } finally {
    console.log = originalLog
    console.error = originalError
  }
  assert.deepEqual(calls, [])
})

test('Admin dispute resolution form validates the supported decimal and optional note', () => {
  assert.match(validateDisputeResolution({ amount: '', note: '' }), /Enter 0/)
  assert.match(validateDisputeResolution({ amount: '0', note: 'x' }), /Resolution note/)
  assert.equal(validateDisputeResolution({ amount: '1200.50', note: 'Resolution recorded' }), '')
})
