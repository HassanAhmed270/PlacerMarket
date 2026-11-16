const PAYOUT_STATUS_LABELS = Object.freeze({
  initiated: 'Payout being prepared',
  paid: 'Paid',
  failed: 'Payout could not be completed. Our team will retry it.',
})

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const COMMISSION_ERROR = 'Enter a percentage from 0 to 100 with at most 2 decimal places.'

function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function localDateString(date = new Date()) {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function dateDaysBefore(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

export function formatPkr(amount) {
  if (typeof amount !== 'string') return '—'
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(amount.trim())
  if (!match) return '—'
  const whole = match[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `PKR ${match[1]}${whole}${match[3] || ''}`
}

export function payoutStatusLabel(status) {
  return Object.hasOwn(PAYOUT_STATUS_LABELS, status)
    ? PAYOUT_STATUS_LABELS[status]
    : 'Payout status unavailable'
}

export function canApprove(input = {}) {
  const { payout, currentAdminId } = input || {}
  return Boolean(
    payout?.requiresApproval === true &&
    payout.status === 'initiated' &&
    !payout.approvedBy &&
    currentAdminId &&
    payout.initiatedBy &&
    currentAdminId !== payout.initiatedBy
  )
}

export function canMarkPaid(input = {}) {
  const { payout } = input || {}
  return Boolean(
    payout?.status === 'initiated' &&
    (!payout.requiresApproval || Boolean(payout.approvedBy))
  )
}

export function canRetry(input = {}) {
  const { payout } = input || {}
  return payout?.status === 'failed'
}

export function canMarkFailed(input = {}) {
  const { payout } = input || {}
  return payout?.status === 'initiated'
}

export function validatePaidForm(input = {}) {
  const {
    method,
    transferReference,
    paidOn,
    today = localDateString(),
  } = input || {}
  if (!['bank', 'easypaisa', 'jazzcash'].includes(method)) {
    return 'Choose bank, Easypaisa, or JazzCash.'
  }
  if (typeof transferReference !== 'string' ||
      transferReference.trim().length < 6 || transferReference.trim().length > 100) {
    return 'Transfer reference must be 6 to 100 characters.'
  }
  if (!isValidDate(paidOn)) return 'Enter a valid paid-on date.'
  if (!isValidDate(today)) return 'Today’s date is unavailable.'
  if (paidOn > today) return 'Paid-on date cannot be in the future.'
  if (paidOn < dateDaysBefore(today, 90)) return 'Paid-on date cannot be older than 90 days.'
  return ''
}

export function validateFailedForm(input = {}) {
  const { reason } = input || {}
  if (typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 300) {
    return 'Failure reason must be 3 to 300 characters.'
  }
  return ''
}

export function validateHeldDecision(input = {}) {
  const { decision, note } = input || {}
  if (!['release', 'keep_held'].includes(decision)) {
    return 'Choose Release or Keep held.'
  }
  if (decision === 'keep_held' &&
      (typeof note !== 'string' || note.trim().length < 3 || note.trim().length > 300)) {
    return 'A note between 3 and 300 characters is required to keep funds held.'
  }
  return ''
}

export function validateExportFilters(input = {}) {
  const { status = '', from = '', to = '' } = input || {}
  if (status && !['initiated', 'paid', 'failed'].includes(status)) {
    return 'Choose a valid payout status.'
  }
  if (from && !isValidDate(from)) return 'Enter a valid start date.'
  if (to && !isValidDate(to)) return 'Enter a valid end date.'
  if (from && to && from > to) return 'Start date cannot be after end date.'
  return ''
}

export function validateCommissionPercent(text) {
  if (typeof text !== 'string') return COMMISSION_ERROR
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim())
  if (!match) return COMMISSION_ERROR

  const whole = match[1].replace(/^0+(?=\d)/, '')
  const fraction = match[2] || ''
  if (whole.length > 3 || (whole.length === 3 && whole > '100') ||
      (whole === '100' && /[1-9]/.test(fraction))) {
    return COMMISSION_ERROR
  }
  return ''
}
