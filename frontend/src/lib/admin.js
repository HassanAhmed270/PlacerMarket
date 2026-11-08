const STATUS_LABELS = Object.freeze({
  bag: 'Bag',
  order_placed: 'Order placed',
  seller_preparing: 'Seller preparing',
  reserved: 'Reserved',
  payment_pending: 'Payment pending',
  funded: 'Funded',
  handed_to_delivery: 'Handed to delivery',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  held: 'Payout held',
  completed: 'Completed',
  cancelled: 'Cancelled',
  refused_at_door: 'Refused at door',
  return_requested: 'Return requested',
  returned: 'Returned',
  refunded: 'Refunded',
  dispute_refund_required: 'Dispute refund required (manual)',
})

const ERROR_MESSAGES = Object.freeze({
  400: 'The request could not be accepted. Check the fields and try again.',
  401: 'Your Admin session has expired. Sign in again.',
  403: 'Your account does not have permission to do this.',
  404: 'The requested record could not be found.',
  409: 'The record changed or is not eligible for this action.',
  422: 'The server could not process this request.',
  429: 'Too many requests, wait a moment.',
  503: 'The service is temporarily unavailable. Try again later.',
})

export function buildAdminOrderQuery({ status = '', before = '', limit = 20 } = {}) {
  const query = { limit }
  if (status) query.status = status
  if (before) query.before = before
  return query
}

export function validateHandoverForm({ courierPickupAt, handoverConfirmationNote, trackingNumber = '', fundedAt }, now = Date.now()) {
  if (!courierPickupAt || !Number.isFinite(Date.parse(courierPickupAt))) {
    return 'Enter a valid courier pickup time.'
  }
  const pickupTime = Date.parse(courierPickupAt)
  if (pickupTime > now) return 'Courier pickup time cannot be in the future.'
  const fundingTime = Date.parse(fundedAt)
  if (!fundedAt || !Number.isFinite(fundingTime)) return 'Order funding time is unavailable.'
  if (pickupTime < fundingTime) return 'Courier pickup time cannot be before the order was funded.'
  if (typeof handoverConfirmationNote !== 'string' ||
      handoverConfirmationNote.trim().length < 3 || handoverConfirmationNote.trim().length > 500) {
    return 'Handover note must be 3 to 500 characters.'
  }
  if (trackingNumber && (trackingNumber.trim().length < 1 || trackingNumber.trim().length > 100)) {
    return 'Tracking number must be 1 to 100 characters.'
  }
  return ''
}

export function validatePayoutForm({ payoutReference, note }) {
  if (typeof payoutReference !== 'string' ||
      payoutReference.trim().length < 3 || payoutReference.trim().length > 100) {
    return 'Payout reference must be 3 to 100 characters.'
  }
  if (typeof note !== 'string' || note.trim().length < 3 || note.trim().length > 500) {
    return 'Payout note must be 3 to 500 characters.'
  }
  return ''
}

export function validateExceptionResolutionNote(note) {
  return typeof note === 'string' && note.trim().length >= 3 && note.trim().length <= 500
    ? ''
    : 'Resolution note must be 3 to 500 characters.'
}

export function validateDisputeResolution({ amount, note }) {
  if (typeof amount !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(amount.trim())) {
    return 'Enter 0 for full release or the full item price for a refund.'
  }
  if (note && (note.trim().length < 3 || note.trim().length > 500)) {
    return 'Resolution note must be 3 to 500 characters when provided.'
  }
  return ''
}

export function adminErrorMessage(error) {
  const status = Number(error?.status)
  const serverMessage = error?.payload?.error
  if ([400, 403, 404, 409, 422].includes(status) &&
      typeof serverMessage === 'string' && serverMessage.trim()) {
    return serverMessage
  }
  return ERROR_MESSAGES[status] || 'The request could not be completed. Please try again.'
}

export function adminLoginErrorMessage(error) {
  const serverMessage = error?.payload?.error
  if (Number(error?.status) === 401 && typeof serverMessage === 'string' && serverMessage.trim()) {
    return serverMessage
  }
  return adminErrorMessage(error)
}

export function adminHandoverErrorMessage(error) {
  const serverMessage = error?.payload?.error
  if (Number(error?.status) === 409 && typeof serverMessage === 'string' &&
      /auto.?cancel|cancelled/i.test(serverMessage)) {
    return `The order was not reopened; an exception was recorded. Resolve it under Exceptions. ${serverMessage}`
  }
  return adminErrorMessage(error)
}

export function isRecordedHandoverConflict(error) {
  const serverMessage = error?.payload?.error
  return Number(error?.status) === 409 && typeof serverMessage === 'string' &&
    /auto.?cancel|cancelled/i.test(serverMessage)
}

export function formatAdminAmount(amount, currency) {
  if (typeof amount !== 'string') return 'Amount unavailable'
  return currency ? `${currency} ${amount}` : amount
}

export function formatAdminDate(value, options = {}) {
  if (!value) return '—'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...options,
  }).format(date)
}

export function payoutReleaseMessage(hold, now = Date.now()) {
  const releaseTime = hold?.earliestReleaseAt
  if (!releaseTime || !Number.isFinite(Date.parse(releaseTime))) return 'Release timing is not available yet.'
  if (now < Date.parse(releaseTime)) return `Can be released after ${formatAdminDate(releaseTime)}.`
  return 'The payout hold windows have elapsed; payout can be released now.'
}

export function adminStatusLabel(status) {
  if (!status) return 'Unknown'
  return STATUS_LABELS[status] || status.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function deliveryCityActionLabel(active) {
  return active ? 'Deactivate' : 'Activate'
}

export function validateManualRefundReason(reason) {
  if (typeof reason !== 'string' || reason.trim().length < 20 || reason.trim().length > 1000) {
    return 'A reason between 20 and 1000 characters is required.'
  }
  return ''
}

export function buildManualRefundRequestPayload(reason, stepUpGrant) {
  return { reason: reason.trim(), stepUpGrant }
}

export function manualRefundAgeLabel(requestedAt, now = Date.now()) {
  const timestamp = Date.parse(requestedAt)
  if (!Number.isFinite(timestamp)) return '—'
  const elapsedMinutes = Math.max(0, Math.floor((now - timestamp) / 60000))
  const hours = Math.floor(elapsedMinutes / 60)
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h ago`
  if (hours > 0) return `${hours}h ${elapsedMinutes % 60}m ago`
  return `${elapsedMinutes}m ago`
}

export function manualRefundExpiryLabel(expiresAt, now = Date.now()) {
  const timestamp = Date.parse(expiresAt)
  if (!Number.isFinite(timestamp)) return 'Expiry unavailable'
  const remainingMinutes = Math.ceil((timestamp - now) / 60000)
  if (remainingMinutes <= 0) return 'Expired'
  const hours = Math.floor(remainingMinutes / 60)
  return hours > 0
    ? `Expires in ${hours}h ${remainingMinutes % 60}m`
    : `Expires in ${remainingMinutes}m`
}

export function canDecideManualRefund(refund, now = Date.now()) {
  const expiresAt = Date.parse(refund?.expiresAt)
  return refund?.status === 'requested' && refund.requestedByMe !== true &&
    Number.isFinite(expiresAt) && expiresAt > now
}

export function orderActionEligibility(order, permissions = {}, now = Date.now()) {
  const cancelledAfterFunding = order?.status === 'cancelled' && Boolean(order?.fundedAt) && !order?.handedOverAt
  const handoverStatus = order?.status === 'funded' || cancelledAfterFunding
  const handoverAllowed = Boolean(
    permissions.markHandover && handoverStatus &&
    order?.paymentStatus === 'succeeded' && !order?.handedOverAt &&
    order?.handoverDeadlineAt && !order?.hasUnresolvedException
  )
  const deliveredAllowed = Boolean(
    permissions.markDelivered &&
    ['handed_to_delivery', 'out_for_delivery'].includes(order?.status) &&
    order?.paymentStatus === 'succeeded' && order?.handedOverAt && !order?.deliveredAt
  )
  const releaseTime = order?.payoutHold?.earliestReleaseAt
  const releaseDate = releaseTime ? Date.parse(releaseTime) : NaN
  const holdIsReady = order?.payoutHold?.state === 'held' &&
    Number.isFinite(releaseDate) && now >= releaseDate &&
    order?.status === 'held' && !order?.hasOpenDispute
  const payoutAllowed = Boolean(permissions.releasePayout && holdIsReady)
  let payoutHint = ''
  if (order?.hasOpenDispute || order?.payoutHold?.state === 'paused_for_dispute') {
    payoutHint = 'Payout release is paused while a dispute is open.'
  } else if (releaseTime && Number.isFinite(releaseDate) && now < releaseDate) {
    payoutHint = `Can be released after ${formatAdminDate(releaseTime)}.`
  } else if (order?.payoutHold?.state && order.payoutHold.state !== 'held') {
    payoutHint = 'Payout is not in a releasable hold state.'
  }
  return {
    handover: { allowed: handoverAllowed, hint: handoverAllowed ? '' : 'Handover is available only for funded, paid orders not yet handed over.' },
    delivered: { allowed: deliveredAllowed, hint: deliveredAllowed ? '' : 'Mark delivered after a paid order has been handed to delivery.' },
    payout: { allowed: payoutAllowed, hint: payoutHint || (payoutAllowed ? '' : 'Payout release is not currently available.') },
  }
}

export function localDateTimeToIsoWithOffset(value, offsetMinutes) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    return ''
  }
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const [year, month, day, hour, minute] = value.split(/[-T:]/).map(Number)
  if (date.getFullYear() !== year || date.getMonth() + 1 !== month ||
      date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute) {
    return ''
  }
  const timezoneOffset = Number.isFinite(offsetMinutes) ? offsetMinutes : date.getTimezoneOffset()
  const localOffset = -timezoneOffset
  const sign = localOffset >= 0 ? '+' : '-'
  const absoluteOffset = Math.abs(localOffset)
  const offset = `${sign}${String(Math.floor(absoluteOffset / 60)).padStart(2, '0')}:${String(absoluteOffset % 60).padStart(2, '0')}`
  return `${value}:00${offset}`
}
