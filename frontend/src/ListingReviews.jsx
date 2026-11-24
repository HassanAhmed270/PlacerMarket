import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import { formatPublicReview } from './lib/reviewHelpers.js'
import { getBuyDestination } from './lib/browse.js'
import { getOrderFlowError } from './lib/orderFlows.js'

export default function ListingReviews({ listingKey }) {
  const [reviews, setReviews] = useState([])
  const [nextCursor, setNextCursor] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reportingId, setReportingId] = useState('')
  const [reason, setReason] = useState('')
  const [actionMessage, setActionMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const [pendingId, setPendingId] = useState('')

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

  async function submitReport(event, reviewId) {
    event.preventDefault()
    setActionError('')
    setActionMessage('')
    setPendingId(reviewId)
    try {
      await api.reportReview(reviewId, reason)
      setActionMessage('Thanks. A moderator will look at this review.')
      setReportingId('')
      setReason('')
    } catch (cause) {
      setActionError(getOrderFlowError(cause))
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
      {actionMessage && <p role="status">{actionMessage}</p>}
      {actionError && <p className="workspace-error" role="alert">{actionError}</p>}
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
              {api.isAuthenticated()
                ? <button className="text-button" type="button" onClick={() => { setReportingId(review.id); setReason('') }}>Report</button>
                : <button className="text-button" type="button" onClick={signInToReport}>Sign in to report a review</button>}
              {reportingId === review.id && (
                <form onSubmit={(event) => submitReport(event, review.id)}>
                  <label htmlFor={`review-reason-${review.id}`}>Reason</label>
                  <textarea id={`review-reason-${review.id}`} minLength="3" maxLength="300" value={reason} onChange={(event) => setReason(event.target.value)} required />
                  <button className="button button-secondary" type="submit" disabled={pendingId === review.id}>Submit report</button>
                </form>
              )}
            </li>
          )
        })}
      </ol>
      {nextCursor && <button className="button button-secondary" type="button" disabled={loading} onClick={() => load(nextCursor)}>Load more</button>}
    </section>
  )
}
