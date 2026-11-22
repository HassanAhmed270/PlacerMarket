import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getDeliveryOutcomeLabel,
  getDisputeFlowLabel,
  getReviewFlowLabel,
  getReturnFlowLabel,
  getSellerFlowError,
  getSellerOrderAllowedActions,
} from './orderFlows.js'

test('seller flow error rule a preserves client validation messages without an HTTP status', () => {
  assert.equal(getSellerFlowError(new Error('Rating must be between 1 and 5')),
    'Rating must be between 1 and 5')
})

test('seller flow TypeError fetch failures return the connection message', () => {
  assert.equal(getSellerFlowError(new TypeError('Failed to fetch')),
    'Could not reach the marketplace. Check your connection and retry.')
})

test('seller flow AbortError and NetworkError failures return the connection message', () => {
  const expected = 'Could not reach the marketplace. Check your connection and retry.'
  assert.equal(getSellerFlowError(new DOMException('Request aborted', 'AbortError')), expected)
  const abortError = new Error('Request aborted')
  abortError.name = 'AbortError'
  assert.equal(getSellerFlowError(abortError), expected)
  const networkError = new Error('Network failed')
  networkError.name = 'NetworkError'
  assert.equal(getSellerFlowError(networkError), expected)
})

test('seller flow plain Error validation messages remain visible', () => {
  assert.equal(getSellerFlowError(new Error('Evidence note must be 3 to 500 characters.')),
    'Evidence note must be 3 to 500 characters.')
})

test('seller flow ApiError-like status 500 uses the generic message', () => {
  assert.equal(getSellerFlowError({ name: 'ApiError', status: 500, message: 'Server details' }),
    'The request could not be completed. Please try again.')
})

test('seller flow error rule b gives a connection message for status 0 or missing status without a message', () => {
  const expected = 'Could not reach the marketplace. Check your connection and retry.'
  assert.equal(getSellerFlowError({ status: 0 }), expected)
  assert.equal(getSellerFlowError({}), expected)
})

test('seller flow error rule c uses server messages for validation and conflict statuses', () => {
  for (const status of [400, 409, 422]) {
    assert.equal(getSellerFlowError({ status, payload: { error: 'The action was rejected.' } }),
      'The action was rejected.')
  }
  assert.equal(getSellerFlowError({ status: 400 }),
    'This action is no longer available. Refresh the page and try again.')
})

test('seller flow error rule d gives session guidance for unauthorized responses', () => {
  assert.equal(getSellerFlowError({ status: 401 }), 'Your session expired. Sign in again.')
  assert.equal(getSellerFlowError({ status: 403 }), 'Your session expired. Sign in again.')
})

test('seller flow error rule e maps missing items to a designed message', () => {
  assert.equal(getSellerFlowError({ status: 404 }), 'This item could not be found.')
})

test('seller flow error rule f asks users to wait after rate limiting', () => {
  assert.equal(getSellerFlowError({ status: 429 }),
    'Too many attempts. Please wait a moment and try again.')
})

test('seller flow error rule g gives a neutral message for other HTTP statuses', () => {
  assert.equal(getSellerFlowError({ status: 500 }), 'The request could not be completed. Please try again.')
})

test('seller flow error handles objects with unexpected shapes', () => {
  assert.equal(getSellerFlowError({ status: '401', message: { detail: 'secret' }, payload: { error: {} } }),
    'The request could not be completed. Please try again.')
})

test('return, dispute, review and delivery status tables cover known and unknown statuses', () => {
  assert.equal(getReturnFlowLabel('requested'), 'Return requested; the Admin has not decided it yet.')
  assert.equal(getReturnFlowLabel('seller_responded'), 'Your response was sent; the Admin is reviewing the return.')
  assert.equal(getReturnFlowLabel('approved'), 'The return was approved.')
  assert.equal(getReturnFlowLabel('rejected'), 'The return was rejected.')
  assert.equal(getReturnFlowLabel('unexpected'), 'Status unavailable')

  assert.equal(getDisputeFlowLabel('open'), 'Dispute open; an Admin is reviewing it.')
  assert.equal(getDisputeFlowLabel('seller_responded'), 'Your response was sent; the dispute is still open.')
  assert.equal(getDisputeFlowLabel('resolved_refund'), 'The dispute was decided in the buyer’s favour.')
  assert.equal(getDisputeFlowLabel('resolved_release'), 'The dispute was decided in the seller’s favour.')
  assert.equal(getDisputeFlowLabel('resolved_other'), 'The dispute is closed.')
  assert.equal(getDisputeFlowLabel('withdrawn'), 'The dispute was withdrawn.')
  assert.equal(getDisputeFlowLabel(null), 'Status unavailable')

  assert.equal(getReviewFlowLabel({ state: 'hidden_until_reveal' }),
    'Submitted; visible when the buyer reviews or the review window closes.')
  assert.equal(getReviewFlowLabel({ state: 'visible' }), 'Visible')
  assert.equal(getReviewFlowLabel({ state: 'unexpected' }), 'Status unavailable')
  assert.equal(getReviewFlowLabel(null), 'Status unavailable')

  assert.equal(getDeliveryOutcomeLabel({ outcome: 'refused' }), 'Delivery refused at the door')
  assert.equal(getDeliveryOutcomeLabel({ outcome: 'lost' }), 'Delivery marked lost')
  assert.equal(getDeliveryOutcomeLabel(null), 'Status unavailable')
})

test('seller allowed actions follow backend status and dispute action fields', () => {
  assert.deepEqual(getSellerOrderAllowedActions({
    status: 'completed',
    returnRequest: { status: 'requested' },
    disputeActions: { canCounter: true, canAddEvidence: true },
  }), ['respond_to_return', 'submit_counter_evidence', 'add_dispute_evidence', 'review_buyer'])

  assert.deepEqual(getSellerOrderAllowedActions({
    status: 'completed',
    disputeStatus: 'open',
  }), ['review_buyer'])

  assert.deepEqual(getSellerOrderAllowedActions({
    status: 'completed',
    myReview: { state: 'hidden_until_reveal' },
  }), [])
})

test('seller review action is allowed with a resolved dispute', () => {
  assert.deepEqual(getSellerOrderAllowedActions({
    status: 'completed',
    disputeStatus: 'resolved_release',
  }), ['review_buyer'])
})

test('seller review action is allowed with a rejected return', () => {
  assert.deepEqual(getSellerOrderAllowedActions({
    status: 'completed',
    returnRequest: { status: 'rejected' },
  }), ['review_buyer'])
})

test('seller review action is allowed when a chargeback is present', () => {
  assert.deepEqual(getSellerOrderAllowedActions({
    status: 'completed',
    chargebacks: [{ status: 'open' }],
  }), ['review_buyer'])
})

test('seller review action remains allowed alongside open return and dispute actions', () => {
  assert.deepEqual(getSellerOrderAllowedActions({
    status: 'completed',
    returnRequest: { status: 'requested' },
    disputeActions: { canCounter: true, canAddEvidence: true },
  }), ['respond_to_return', 'submit_counter_evidence', 'add_dispute_evidence', 'review_buyer'])
})

test('seller review action is unavailable before completion', () => {
  assert.deepEqual(getSellerOrderAllowedActions({ status: 'delivered' }), [])
})
