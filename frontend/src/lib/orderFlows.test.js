import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getDeliveryOutcomeLabel,
  getDisputeFlowLabel,
  getReviewFlowLabel,
  getReturnFlowLabel,
  getSellerOrderAllowedActions,
} from './orderFlows.js'

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
  }), ['respond_to_return', 'submit_counter_evidence', 'add_dispute_evidence'])

  assert.deepEqual(getSellerOrderAllowedActions({
    status: 'completed',
    disputeStatus: 'open',
  }), [])

  assert.deepEqual(getSellerOrderAllowedActions({
    status: 'completed',
    myReview: null,
    disputeStatus: null,
    returnStatus: null,
    chargebacks: [],
  }), ['review_buyer'])

  assert.deepEqual(getSellerOrderAllowedActions({
    status: 'completed',
    myReview: { state: 'hidden_until_reveal' },
  }), [])
})
