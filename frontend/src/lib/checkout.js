const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PHONE = /^\+?[1-9]\d{7,19}$/

export const PAYMENT_POLL_INTERVAL_MS = 2_000
export const PAYMENT_POLL_MAX_DURATION_MS = 60_000

export function validateCheckoutAddress(input = {}) {
  const values = {
    recipientName: typeof input.recipientName === 'string' ? input.recipientName.trim() : '',
    phone: typeof input.phone === 'string' ? input.phone.trim() : '',
    cityId: typeof input.cityId === 'string' ? input.cityId.trim() : '',
    addressLine1: typeof input.addressLine1 === 'string' ? input.addressLine1.trim() : '',
    addressLine2: typeof input.addressLine2 === 'string' ? input.addressLine2.trim() : '',
    postalCode: typeof input.postalCode === 'string' ? input.postalCode.trim() : '',
  }
  const errors = {}

  if (values.recipientName.length < 2 || values.recipientName.length > 100) {
    errors.recipientName = 'Enter a recipient name from 2 to 100 characters.'
  }
  if (!PHONE.test(values.phone)) {
    errors.phone = 'Enter a phone number in international format, such as +15551234567.'
  }
  if (!UUID.test(values.cityId)) errors.cityId = 'Choose a supported delivery city.'
  if (values.addressLine1.length < 5 || values.addressLine1.length > 200) {
    errors.addressLine1 = 'Enter an address from 5 to 200 characters.'
  }
  if (values.addressLine2.length > 200) errors.addressLine2 = 'Address line 2 must be at most 200 characters.'
  if (values.postalCode.length > 20) errors.postalCode = 'Postal code must be at most 20 characters.'

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    address: {
      recipientName: values.recipientName,
      phone: values.phone,
      cityId: values.cityId,
      addressLine1: values.addressLine1,
      addressLine2: values.addressLine2 || null,
      postalCode: values.postalCode || null,
    },
  }
}

export function safeCheckoutRedirectUrl(value, { production = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value)
    if (url.username || url.password) return null
    if (url.protocol === 'https:') return url.href
    if (!production && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)) {
      return url.href
    }
    return null
  } catch {
    return null
  }
}

export function formatReservationCountdown(expiresAt, now = Date.now()) {
  const expiresAtMs = Date.parse(expiresAt)
  if (!Number.isFinite(expiresAtMs)) return '--:--:--'
  const secondsRemaining = Math.max(0, Math.ceil((expiresAtMs - now) / 1000))
  const hours = String(Math.floor(secondsRemaining / 3600)).padStart(2, '0')
  const minutes = String(Math.floor((secondsRemaining % 3600) / 60)).padStart(2, '0')
  const seconds = String(secondsRemaining % 60).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}

export function getOrderStatusMessage(summary = {}) {
  const orderStatus = summary.status
  const reservationStatus = summary.reservation?.status
  const paymentStatus = summary.payment?.status

  if (paymentStatus === 'late') {
    return {
      title: 'Late payment is being refunded',
      message: 'The server recorded payment after the reservation expired. A refund is being processed.',
      final: true,
    }
  }
  if (orderStatus === 'funded') {
    return {
      title: 'Payment received, waiting for the seller to hand over',
      message: 'Your payment has been confirmed. The seller has until the handover deadline shown below.',
      final: true,
    }
  }
  if (orderStatus === 'expired' || reservationStatus === 'expired') {
    return { title: 'Reservation expired', message: 'The payment window ended before payment was confirmed.', final: true }
  }
  if (orderStatus === 'cancelled' || reservationStatus === 'cancelled') {
    return { title: 'Order cancelled', message: 'This reservation was cancelled.', final: true }
  }
  if (paymentStatus === 'failed' || paymentStatus === 'cancelled') {
    return { title: 'Payment failed', message: 'The server has not confirmed payment. You can try again from this order.', final: true }
  }

  const messages = {
    reserved: ['Reservation active', 'Complete payment before the reservation expires.'],
    payment_pending: ['Payment pending', 'The server is waiting for a verified payment update.'],
    seller_preparing: ['Seller preparing your order', 'Payment was received and the seller is preparing the item.'],
    handed_to_delivery: ['Handed to delivery partner', 'Your order has been handed to the delivery partner.'],
    out_for_delivery: ['Out for delivery', 'Your order is on its way.'],
    delivered: ['Delivered', 'The order has been marked delivered.'],
    completed: ['Order complete', 'This order is complete.'],
  }
  const [title, message] = messages[orderStatus] || ['Order status', 'The latest order status is shown here.']
  return { title, message, final: false }
}

export function shouldStopPaymentPolling(summary, startedAt, now = Date.now()) {
  return getOrderStatusMessage(summary).final
    || now - startedAt >= PAYMENT_POLL_MAX_DURATION_MS
}

export function getCheckoutError(error) {
  const status = error?.status
  const code = error?.payload?.code
  const serverMessage = error?.payload?.error

  if (code === 'payments_disabled') {
    return { type: 'payments-disabled', message: 'Payments are turned off. No reservation was made.' }
  }
  if (code === 'busy_try_again') {
    return { type: 'retry', message: 'The marketplace is busy. Please retry in a moment.' }
  }
  if (status === 409) {
    if (/price changed/i.test(serverMessage || '')) {
      return { type: 'price-changed', message: 'The listing price changed. Return to the listing and review it again.' }
    }
    if (/limit|cap|active unpaid/i.test(serverMessage || '')) {
      return { type: 'reservation-cap', message: 'You have reached the limit of active unpaid reservations.' }
    }
    return { type: 'listing-unavailable', message: 'This listing is no longer available for reservation.' }
  }
  if (status === 422) {
    return { type: 'unsupported-city', message: 'Delivery is not available in that city. Choose another supported city.' }
  }
  if (status === 400) {
    return { type: 'validation', message: serverMessage || 'Check the address details and try again.' }
  }
  if (status === 503) {
    return { type: 'retry', message: 'Checkout is temporarily unavailable. Please retry in a moment.' }
  }
  if (status === undefined || status === 0) {
    return { type: 'network', message: 'Could not reach the marketplace. Check your connection and retry.' }
  }
  return { type: 'request', message: serverMessage || 'The request could not be completed. Please try again.' }
}
