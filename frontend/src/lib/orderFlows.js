export function getOrderFlowError(error) {
  const status = error?.status
  const message = typeof error?.message === 'string' ? error.message.trim() : ''
  const serverMessage = typeof error?.payload?.error === 'string'
    ? error.payload.error.trim()
    : ''

  if (error instanceof TypeError ||
      ['TypeError', 'AbortError', 'NetworkError'].includes(error?.name)) {
    return 'Could not reach the marketplace. Check your connection and retry.'
  }
  if (typeof status !== 'number' && message) return error.message
  if ((status === 0 || status === undefined) && !message) {
    return 'Could not reach the marketplace. Check your connection and retry.'
  }
  if ([400, 409, 422].includes(status)) {
    return serverMessage || 'This action is no longer available. Refresh the page and try again.'
  }
  if (status === 401 || status === 403) return 'Your session expired. Sign in again.'
  if (status === 404) return 'This item could not be found.'
  if (status === 429) return 'Too many attempts. Please wait a moment and try again.'
  return 'The request could not be completed. Please try again.'
}

export const getSellerFlowError = getOrderFlowError


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
  if (order?.status === 'completed' && !order?.myReview && !order?.disputeFiling?.disputeStatus) {
    actions.push('review_buyer')
  }
  return actions
}

export function getBuyerOrderAllowedActions(order) {
  const actions = []
  if (order?.returnFiling?.canRequestReturn) actions.push('request_return')
  if (order?.disputeFiling?.canFileDispute) actions.push('file_dispute')
  if (order?.disputeActions?.canAddEvidence) actions.push('add_dispute_evidence')
  if (order?.disputeActions?.canWithdraw) actions.push('withdraw_dispute')
  if (order?.status === 'completed' && !order?.myReview) {
    actions.push('review_seller')
  }
  return actions
}
