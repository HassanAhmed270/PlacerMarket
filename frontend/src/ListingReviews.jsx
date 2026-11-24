import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import { formatPublicReview } from './lib/reviewHelpers.js'
import { getBuyDestination } from './lib/browse.js'
import { getOrderFlowError, getReviewActionError } from './lib/orderFlows.js'

export default function ListingReviews({ listingKey }) {
  const [reviews, setReviews] = useState([])
  const [nextCursor, setNextCursor] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reportingId, setReportingId] = useState('')
  const [reason, setReason] = useState('')
  const [reportMessage, setReportMessage] = useState(null)
  const [pendingId, setPendingId] = useState('')
  const [refreshingId, setRefreshingId] = useState('')

  async function load(cursor = null) {
    setLoading(true)
    setError('')
    try {
      const result = await api.getListingReviews(listingKey, { limit: 20, ...(cursor ? { cursor } : {}) })
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
        const result = await api.getListingReviews(listingKey, { limit: 20 })
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
  }, [listingKey])

  function signInToReport() {
    const destination = getBuyDestination({ authenticated: false, listingPath: window.location.pathname })
    window.location.assign(destination.url)
  }

  async function openReport(reviewId) {
    setReportMessage(null)
    if (api.isAuthenticated()) {
      setReason('')
      setReportingId(reviewId)
      return
    }

    setRefreshingId(reviewId)
    try {
      const session = await api.refresh()
      api.setAccessToken(session.accessToken)
      setReason('')
      setReportingId(reviewId)
    } catch {
      signInToReport()
    } finally {
      setRefreshingId('')
    }
  }

  async function submitReport(event, reviewId) {
    event.preventDefault()
    setReportMessage(null)
    setPendingId(reviewId)
    try {
      await api.reportReview(reviewId, reason)
      setReportMessage({
        reviewId,
        kind: 'success',
        text: 'Thanks. A moderator will look at this review.',
      })
      setReportingId('')
      setReason('')
    } catch (cause) {
      setReportMessage({ reviewId, kind: 'error', text: getReviewActionError(cause) })
    } finally {
      setPendingId('')
    }
  }

  return (
    <section className="listing-reviews" aria-labelledby="listing-reviews-title">
      <p className="eyebrow">Buyer feedback</p>
      <h2 id="listing-reviews-title">Reviews</h2>
      {loading && reviews.length === 0 && <p role="status">Loading reviews…</p>}
      {error && <p className="workspace-error" role="alert">{error}</p>}
      {!loading && !error && reviews.length === 0 && <p>No reviews yet</p>}
      <ol className="listing-review-list">
        {reviews.map((review) => {
          const display = formatPublicReview(review)
          return (
            <li key={review.id} className="listing-review">
              <strong>{display.reviewer}</strong>
              <p>{display.rating}</p>
              {display.itemRating && <p>{display.itemRating}</p>}
              {review.body && <p>{review.body}</p>}
              <p>{display.date}</p>
              <button
                className="text-button"
                type="button"
                disabled={refreshingId === review.id}
                onClick={() => openReport(review.id)}
              >
                {refreshingId === review.id ? 'Checking sign-in…' : 'Report'}
              </button>
              {reportingId === review.id && (
                <form onSubmit={(event) => submitReport(event, review.id)}>
                  <label htmlFor={`review-reason-${review.id}`}>Reason</label>
                  <textarea id={`review-reason-${review.id}`} minLength="3" maxLength="300" value={reason} onChange={(event) => setReason(event.target.value)} required />
                  <button className="button button-secondary" type="submit" disabled={pendingId === review.id}>Submit report</button>
                </form>
              )}
              {reportMessage?.reviewId === review.id && (
                <p role={reportMessage.kind === 'success' ? 'status' : 'alert'}>{reportMessage.text}</p>
              )}
            </li>
          )
        })}
      </ol>
      {nextCursor && <button className="button button-secondary" type="button" disabled={loading} onClick={() => load(nextCursor)}>Load more</button>}
    </section>
  )
}
