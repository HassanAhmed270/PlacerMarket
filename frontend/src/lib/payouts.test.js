import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canApprove,
  canMarkFailed,
  canMarkPaid,
  canRetry,
  formatPkr,
  payoutStatusLabel,
  validateCommissionPercent,
  validateExportFilters,
  validateFailedForm,
  validateHeldDecision,
  validatePaidForm,
} from './payouts.js'

test('FR-48: formatPkr groups string amounts without numeric conversion and is null-safe', () => {
  assert.equal(formatPkr('1187.97'), 'PKR 1,187.97')
  assert.equal(formatPkr('-12345'), 'PKR -12,345')
  assert.equal(formatPkr(null), '—')
  assert.equal(formatPkr(undefined), '—')
  assert.equal(formatPkr(1187.97), '—')
})

test('FR-48: payout status labels cover initiated, paid, failed, and unknown statuses', () => {
  assert.equal(payoutStatusLabel('initiated'), 'Payout being prepared')
  assert.equal(payoutStatusLabel('paid'), 'Paid')
  assert.equal(payoutStatusLabel('failed'), 'Payout could not be completed. Our team will retry it.')
  assert.equal(payoutStatusLabel(null), 'Payout status unavailable')
  assert.equal(payoutStatusLabel('constructor'), 'Payout status unavailable')
})

test('FR-48: payout action helpers enforce approval, payment, and retry eligibility', () => {
  const approvalRequired = {
    status: 'initiated',
    requiresApproval: true,
    approvedBy: null,
    initiatedBy: 'admin-1',
  }
  assert.equal(canApprove({ payout: approvalRequired, currentAdminId: 'admin-2' }), true)
  assert.equal(canApprove({ payout: approvalRequired, currentAdminId: 'admin-1' }), false)
  assert.equal(canApprove({ payout: { ...approvalRequired, approvedBy: 'admin-2' }, currentAdminId: 'admin-3' }), false)
  assert.equal(canApprove({ payout: { ...approvalRequired, status: 'paid' }, currentAdminId: 'admin-2' }), false)
  assert.equal(canApprove({ payout: { ...approvalRequired, requiresApproval: false }, currentAdminId: 'admin-2' }), false)
  assert.equal(canApprove({ payout: approvalRequired }), false)

  assert.equal(canMarkPaid({ payout: { status: 'initiated', requiresApproval: false } }), true)
  assert.equal(canMarkPaid({ payout: { status: 'initiated', requiresApproval: true, approvedBy: 'admin-2' } }), true)
  assert.equal(canMarkPaid({ payout: { status: 'initiated', requiresApproval: true, approvedBy: null } }), false)
  assert.equal(canMarkPaid({ payout: { status: 'failed' } }), false)
  assert.equal(canMarkFailed({ payout: { status: 'initiated' } }), true)
  assert.equal(canMarkFailed({ payout: { status: 'paid' } }), false)
  assert.equal(canRetry({ payout: { status: 'failed' } }), true)
  assert.equal(canRetry({ payout: { status: 'initiated' } }), false)
})

test('FR-48: paid form validates method, reference, real date, and the 90-day window', () => {
  const valid = {
    method: 'bank',
    transferReference: 'BANK-123',
    paidOn: '2026-11-16',
    today: '2026-11-16',
  }
  assert.equal(validatePaidForm(valid), '')
  assert.match(validatePaidForm({ ...valid, method: 'cash' }), /Choose/)
  assert.match(validatePaidForm({ ...valid, transferReference: 'short' }), /reference/)
  assert.match(validatePaidForm({ ...valid, paidOn: '2026-02-30' }), /valid paid-on date/)
  assert.match(validatePaidForm({ ...valid, paidOn: '2026-11-17' }), /future/)
  assert.equal(validatePaidForm({ ...valid, paidOn: '2026-08-18' }), '')
  assert.match(validatePaidForm({ ...valid, paidOn: '2026-08-17' }), /older than 90 days/)
})

test('FR-48: failure and held-funds forms enforce their note requirements', () => {
  assert.match(validateFailedForm(null), /3 to 300/)
  assert.match(validateFailedForm({ reason: '  x  ' }), /3 to 300/)
  assert.equal(validateFailedForm({ reason: 'Transfer returned' }), '')
  assert.equal(validateHeldDecision({ decision: 'release' }), '')
  assert.match(validateHeldDecision({ decision: 'keep_held', note: 'x' }), /3 and 300/)
  assert.equal(validateHeldDecision({ decision: 'keep_held', note: 'Reviewed; keep held' }), '')
  assert.match(validateHeldDecision({ decision: 'forfeit', note: 'No' }), /Release or Keep held/)
  assert.match(validateHeldDecision(null), /Release or Keep held/)
})

test('FR-48: export filters validate statuses and ordered calendar dates', () => {
  assert.equal(validateExportFilters(null), '')
  assert.equal(validateExportFilters({}), '')
  assert.equal(validateExportFilters({ status: 'paid', from: '2026-11-01', to: '2026-11-16' }), '')
  assert.match(validateExportFilters({ status: 'unknown' }), /valid payout status/)
  assert.match(validateExportFilters({ from: '2026-02-30' }), /start date/)
  assert.match(validateExportFilters({ to: '2026-02-30' }), /end date/)
  assert.match(validateExportFilters({ from: '2026-11-17', to: '2026-11-16' }), /after/)
})

test('FR-58: commission percent validation uses strings for the 0–100 range', () => {
  for (const value of ['0', '0.00', '12.5', '100', '100.00']) {
    assert.equal(validateCommissionPercent(value), '')
  }
  for (const value of ['', '100.01', '101', '-1', '1.234', 'abc', 5]) {
    assert.notEqual(validateCommissionPercent(value), '')
  }
})
