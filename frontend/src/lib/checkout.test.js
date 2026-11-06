import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  formatReservationCountdown,
  getCheckoutError,
  getOrderStatusMessage,
  PAYMENT_POLL_INTERVAL_MS,
  PAYMENT_POLL_MAX_DURATION_MS,
  safeCheckoutRedirectUrl,
  shouldStopPaymentPolling,
  validateCheckoutAddress,
} from './checkout.js'

const VALID_ADDRESS = {
  recipientName: 'Buyer Name',
  phone: '+15551234567',
  cityId: '123e4567-e89b-42d3-a456-426614174000',
  addressLine1: '12 Demo Street',
  addressLine2: '',
  postalCode: '',
}

test('checkout address validation mirrors backend limits and normalization', () => {
  const result = validateCheckoutAddress(VALID_ADDRESS)

  assert.equal(result.valid, true)
  assert.deepEqual(result.errors, {})
  assert.deepEqual(result.address, { ...VALID_ADDRESS, addressLine2: null, postalCode: null })
  assert.equal(validateCheckoutAddress({
    ...VALID_ADDRESS,
    recipientName: 'X',
    phone: '123',
    cityId: 'not-a-uuid',
    addressLine1: 'road',
    addressLine2: 'x'.repeat(201),
    postalCode: 'x'.repeat(21),
  }).valid, false)
})

test('checkout redirect permits HTTPS and development loopback only', () => {
  assert.equal(safeCheckoutRedirectUrl('https://pay.example/checkout', { production: true }), 'https://pay.example/checkout')
  assert.equal(safeCheckoutRedirectUrl('http://localhost:3000/fake-gateway', { production: false }), 'http://localhost:3000/fake-gateway')
  assert.equal(safeCheckoutRedirectUrl('http://127.0.0.1:3000/fake-gateway', { production: false }), 'http://127.0.0.1:3000/fake-gateway')
  for (const unsafe of [
    'javascript:alert(1)',
    'data:text/html,hi',
    '//pay.example/checkout',
    'http://pay.example/checkout',
    'http://localhost.evil.example/checkout',
    'https://user:pass@pay.example/checkout',
  ]) {
    assert.equal(safeCheckoutRedirectUrl(unsafe, { production: false }), null)
  }
  assert.equal(safeCheckoutRedirectUrl('http://localhost/checkout', { production: true }), null)
})

test('reservation countdown formats server expiry and clamps expired values', () => {
  assert.equal(formatReservationCountdown('2026-11-04T20:01:02.000Z', Date.parse('2026-11-04T20:00:00.000Z')), '00:01:02')
  assert.equal(formatReservationCountdown('2026-11-04T19:59:00.000Z', Date.parse('2026-11-04T20:00:00.000Z')), '00:00:00')
  assert.equal(formatReservationCountdown('invalid', 0), '--:--:--')
})

test('order statuses map to plain-language final, failed, and late-refund messages', () => {
  assert.deepEqual(getOrderStatusMessage({
    status: 'funded',
    reservation: { status: 'paid' },
  }), {
    title: 'Payment received, waiting for the seller to hand over',
    message: 'Your payment has been confirmed. The seller has until the handover deadline shown below.',
    final: true,
  })
  assert.equal(getOrderStatusMessage({ status: 'payment_pending', payment: { status: 'failed' } }).title, 'Payment failed')
  assert.equal(getOrderStatusMessage({
    status: 'cancelled',
    reservation: { status: 'expired' },
    payment: { status: 'late' },
  }).title, 'Late payment is being refunded')
  assert.equal(getOrderStatusMessage({
    status: 'cancelled',
    reservation: { status: 'expired' },
  }).title, 'Reservation expired')
})

test('held order status tells the buyer it was marked delivered during the complaint window', () => {
  assert.deepEqual(getOrderStatusMessage({ status: 'held' }), {
    title: 'Delivered',
    message: 'Your order was marked delivered. If something is wrong, you can contact support during the complaint window.',
    final: true,
  })
})

test('payment polling stops on final server state or at 60 seconds', () => {
  const startedAt = 1000
  assert.equal(PAYMENT_POLL_INTERVAL_MS, 2000)
  assert.equal(PAYMENT_POLL_MAX_DURATION_MS, 60000)
  assert.equal(shouldStopPaymentPolling({ status: 'payment_pending', payment: { status: 'pending' } }, startedAt, 59999), false)
  assert.equal(shouldStopPaymentPolling({ status: 'funded' }, startedAt, 2000), true)
  assert.equal(shouldStopPaymentPolling({ status: 'payment_pending', payment: { status: 'pending' } }, startedAt, 61000), true)
})

test('checkout errors map server codes and statuses to actionable messages', () => {
  assert.equal(getCheckoutError({ status: 503, payload: { code: 'payments_disabled' } }).type, 'payments-disabled')
  assert.equal(getCheckoutError({ status: 503, payload: { code: 'busy_try_again' } }).type, 'retry')
  assert.equal(getCheckoutError({ status: 409, payload: { error: 'The listing price changed.' } }).type, 'price-changed')
  assert.equal(getCheckoutError({ status: 409, payload: { error: 'Active unpaid cap reached.' } }).type, 'reservation-cap')
  assert.equal(getCheckoutError({ status: 409, payload: { error: 'Listing unavailable.' } }).type, 'listing-unavailable')
  assert.equal(getCheckoutError({ status: 422 }).type, 'unsupported-city')
  assert.equal(getCheckoutError({ status: 400 }).type, 'validation')
  assert.equal(getCheckoutError(new TypeError('fetch failed')).type, 'network')
})
