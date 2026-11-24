export function formatPublicReview(review) {
  const rating = Number.isInteger(review?.rating) ? `${review.rating} star${review.rating === 1 ? '' : 's'}` : 'Rating unavailable'
  const itemRating = Number.isInteger(review?.itemRating) ? `Item rating: ${review.itemRating}/5` : null
  const date = typeof review?.createdAt === 'string' && !Number.isNaN(Date.parse(review.createdAt))
    ? new Date(review.createdAt).toLocaleDateString()
    : 'Date unavailable'
  const reviewer = typeof review?.reviewer?.displayName === 'string' && review.reviewer.displayName.trim()
    ? review.reviewer.displayName
    : 'Reviewer'
  return { rating, itemRating, date, reviewer }
}

export function getReviewModerationActions(review, canRestore) {
  const state = review?.state
  return {
    canHide: state !== 'hidden_by_admin',
    canRestore: Boolean(canRestore) && state === 'hidden_by_admin',
  }
}
