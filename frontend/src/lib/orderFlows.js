export function getReturnFlowLabel(status) {
  const labels = {
    requested: 'Return requested; the Admin has not decided it yet.',
    seller_responded: 'Your response was sent; the Admin is reviewing the return.',
    approved: 'The return was approved.',
    rejected: 'The return was rejected.',
  }
  return labels[status] || 'Status unavailable'
}

export function getDisputeFlowLabel(status) {
  const labels = {
    open: 'Dispute open; an Admin is reviewing it.',
    seller_responded: 'Your response was sent; the dispute is still open.',
    resolved_refund: 'The dispute was decided in the buyer’s favour.',
    resolved_release: 'The dispute was decided in the seller’s favour.',
    resolved_other: 'The dispute is closed.',
    withdrawn: 'The dispute was withdrawn.',
  }
  return labels[status] || 'Status unavailable'
}

export function getReviewFlowLabel(review) {
  if (!review) return 'Status unavailable'
  if (review.state === 'hidden_until_reveal') {
    return 'Submitted; visible when the buyer reviews or the review window closes.'
  }
  if (review.state === 'visible') return 'Visible'
  return 'Status unavailable'
}

export function getDeliveryOutcomeLabel(deliveryOutcome) {
  if (deliveryOutcome?.outcome === 'refused') return 'Delivery refused at the door'
  if (deliveryOutcome?.outcome === 'lost') return 'Delivery marked lost'
  return 'Status unavailable'
}

export function getSellerOrderAllowedActions(order) {
  const actions = []
  if (order?.returnRequest?.status === 'requested') actions.push('respond_to_return')
  if (order?.disputeActions?.canCounter) actions.push('submit_counter_evidence')
  if (order?.disputeActions?.canAddEvidence) actions.push('add_dispute_evidence')
  if (order?.status === 'completed' && !order?.myReview &&
      !order?.disputeStatus && !order?.returnStatus &&
      !order?.disputeActions?.canCounter && !order?.disputeActions?.canAddEvidence &&
      order?.returnRequest?.status !== 'requested' &&
      !order?.chargebacks?.length) {
    actions.push('review_buyer')
  }
  return actions
}
