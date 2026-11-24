import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import { getReviewModerationActions, getReviewStateLabel } from './lib/reviewHelpers.js'
import { getOrderFlowError, getReviewActionError } from './lib/orderFlows.js'

export default function ReviewModerationQueue({ canRestore }) {
  const [reviews, setReviews] = useState([])
  const [nextCursor, setNextCursor] = useState(null)
  const [loading, setLoading] = useState(true)
  const [pendingId, setPendingId] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [reasons, setReasons] = useState({})
  const [restoreReasons, setRestoreReasons] = useState({})
  const [confirmId, setConfirmId] = useState('')
  const [confirmRestoreId, setConfirmRestoreId] = useState('')

  async function refresh(cursor = null) {
    setLoading(true)
    setError('')
    try {
      const result = await api.getReviewModerationQueue({ limit: 50, ...(cursor ? { cursor } : {}) })
      setReviews((current) => cursor ? [...current, ...(result.reviews || [])] : (result.reviews || []))
      setNextCursor(result.nextCursor || null)
    } catch (cause) {
      setError(getOrderFlowError(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(async () => {
      setLoading(true)
      setError('')
      try {
        const result = await api.getReviewModerationQueue({ limit: 50 })
        if (!active) return
        setReviews(result.reviews || [])
        setNextCursor(result.nextCursor || null)
      } catch (cause) {
        if (active) setError(getOrderFlowError(cause))
      } finally {
        if (active) setLoading(false)
      }
    }, 0)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [])

  async function hideReview(reviewId) {
    const reason = (reasons[reviewId] || '').trim()
    setPendingId(reviewId)
    setError('')
    setMessage('')
    try {
      await api.hideReview(reviewId, reason)
      setConfirmId('')
      setMessage('Review hidden.')
      await refresh()
    } catch (cause) {
      setError(getReviewActionError(cause))
    } finally {
      setPendingId('')
    }
  }

  async function restoreReview(reviewId) {
    const reason = (restoreReasons[reviewId] || '').trim()
    setPendingId(reviewId)
    setError('')
    setMessage('')
    try {
      await api.restoreReview(reviewId, reason)
      setConfirmRestoreId('')
      setMessage('Review restored.')
      await refresh()
    } catch (cause) {
      setError(getReviewActionError(cause))
    } finally {
      setPendingId('')
    }
  }

  return (
    <section className="listing-panel">
      <h2>Reviews</h2>
      {loading && reviews.length === 0 && <p role="status">Loading reviews…</p>}
      {error && <p className="workspace-error" role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <div className="admin-list">
        {reviews.map((review) => {
          const actions = getReviewModerationActions(review, canRestore)
          const reports = Array.isArray(review.reports) ? review.reports : []
          return (
            <article className="moderation-card admin-card" key={review.id}>
              <h3>{review.reviewer?.displayName || 'Reviewer unavailable'} → {review.reviewee?.displayName || 'Seller unavailable'}</h3>
              {review.rating != null && <p>{review.rating}/5{review.itemRating != null ? ` · Item ${review.itemRating}/5` : ''}</p>}
              {review.body && <p>{review.body}</p>}
              <p>{review.reportCount || reports.length} report(s)</p>
              {reports.map((report, index) => <p key={`${review.id}-${index}`}>{report.reason}</p>)}
              <p>Status: {getReviewStateLabel(review.state)}</p>
              {actions.canHide && confirmId !== review.id && (
                <>
                  <label>Hide reason<textarea value={reasons[review.id] || ''} maxLength="300" onChange={(event) => setReasons((current) => ({ ...current, [review.id]: event.target.value }))} /></label>
                  <button className="text-button" type="button" disabled={(reasons[review.id] || '').trim().length < 3} onClick={() => setConfirmId(review.id)}>Hide review</button>
                </>
              )}
              {actions.canHide && confirmId === review.id && (
                <div className="admin-inline-confirm" role="group" aria-label="Confirm hiding review">
                  <p>Hide this review? This requires a second confirmation.</p>
                  <button className="button button-primary" type="button" disabled={pendingId === review.id} onClick={() => hideReview(review.id)}>Confirm hide</button>
                  <button className="text-button" type="button" onClick={() => setConfirmId('')}>Cancel</button>
                </div>
              )}
              {actions.canRestore && (
                <>
                  <label>Restore reason
                    <textarea
                      value={restoreReasons[review.id] || ''}
                      maxLength="300"
                      onChange={(event) => setRestoreReasons((current) => ({ ...current, [review.id]: event.target.value }))}
                    />
                  </label>
                  {confirmRestoreId !== review.id && (
                    <button
                      className="text-button"
                      type="button"
                      disabled={(restoreReasons[review.id] || '').trim().length < 3}
                      onClick={() => setConfirmRestoreId(review.id)}
                    >
                      Restore review
                    </button>
                  )}
                  {confirmRestoreId === review.id && (
                    <div className="admin-inline-confirm" role="group" aria-label="Confirm restoring review">
                      <p>Restore this review?</p>
                      <button className="button button-primary" type="button" disabled={pendingId === review.id} onClick={() => restoreReview(review.id)}>Confirm restore</button>
                      <button className="text-button" type="button" onClick={() => setConfirmRestoreId('')}>Cancel</button>
                    </div>
                  )}
                </>
              )}
            </article>
          )
        })}
      </div>
      {reviews.length === 0 && !loading && !error && <p>No reviews awaiting moderation.</p>}
      {nextCursor && <button className="button button-secondary" type="button" disabled={loading} onClick={() => refresh(nextCursor)}>Load more</button>}
    </section>
  )
}
