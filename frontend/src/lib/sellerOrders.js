import { formatPakistanDateTime } from './pakistanTime.js'

const STATUS_MESSAGES = {
  funded: {
    title: 'Paid',
    message: 'Payment is confirmed.',
  },
  handed_to_delivery: {
    title: 'Handed to delivery',
    message: 'The order has been handed to the delivery partner.',
  },
  held: {
    title: 'Delivered',
    message: 'The order has been marked delivered.',
  },
  delivered: {
    title: 'Delivered',
    message: 'The order has been marked delivered.',
  },
  completed: {
    title: 'Order complete',
    message: 'This order is complete.',
  },
  cancelled: {
    title: 'Order cancelled',
    message: 'This order was cancelled.',
  },
}

export function getSellerOrderStatusMessage(status) {
  return STATUS_MESSAGES[status] || {
    title: 'Order status',
    message: 'The latest order status is shown here.',
  }
}

export function getSellerHandoverDeadline(status, deadlineAt, now) {
  if (status !== 'funded') return { text: '', overdue: false }

  const deadline = Date.parse(deadlineAt)
  if (!Number.isFinite(deadline)) return { text: '', overdue: false }

  return {
    text: `Handover deadline: ${formatPakistanDateTime(deadline)}`,
    overdue: deadline < now,
  }
}

export function getSellerPayoutLabel(state) {
  if (state === 'held') {
    return 'Payout held. Our team releases it manually after the hold and complaint periods.'
  }
  if (state === 'paused_for_dispute') return 'Payout paused because of a dispute.'
  if (state === 'released' || state === 'force_released') return 'Payout released.'
  if (state === null || state === undefined) return 'No payout hold yet.'
  return 'Payout status unavailable.'
}

function formatPkr(amount) {
  if (typeof amount !== 'string') return '—'
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(amount.trim())
  if (!match) return '—'
  const whole = match[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `PKR ${match[1]}${whole}${match[3] || ''}`
}

export function getSellerEarningsRows(order) {
  const earnings = order?.earnings
  if (!earnings) return []

  return [
    { label: 'Item price', value: formatPkr(order.itemPrice) },
    {
      label: `Commission (${earnings.commissionPercent}%)`,
      value: formatPkr(earnings.commissionAmount),
    },
    { label: 'Your net earnings', value: formatPkr(earnings.sellerNetAmount) },
  ]
}

export function getSellerPayoutStatusLabel(payout) {
  if (!payout) return 'Not yet released'
  if (payout.status === 'initiated') return 'Payout being prepared'
  if (payout.status === 'paid') {
    return `Paid on ${payout.paidOn || 'date unavailable'} by ${payout.method || 'method unavailable'}, reference ${payout.transferReference || 'not available'}`
  }
  if (payout.status === 'failed') {
    return 'Payout could not be completed. Our team will retry it.'
  }
  return 'Not yet released'
}

export function getHeldFundsBanner(order) {
  return order?.fundsHeldForVerification === true
    ? 'Payout is held until seller identity verification is complete.'
    : ''
}

export function getSellerDisputeLabel(status) {
  if (status === 'open' || status === 'seller_responded') return 'A dispute is open.'
  if (status === 'resolved_release') return 'The dispute was decided in your favour.'
  if (status === 'resolved_refund') {
    return "The dispute was decided in the buyer's favour; payout stays paused."
  }
  if (status === 'resolved_other') return 'The dispute is closed.'
  return null
}
