import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import {
  formatReservationCountdown,
  getCheckoutError,
  getOrderStatusMessage,
  safeCheckoutRedirectUrl,
} from './lib/checkout.js'
import {
  getDeliveryOutcomeLabel,
  getDisputeFlowLabel,
  getOrderFlowError,
  getReviewFlowLabel,
  getReturnFlowLabel,
} from './lib/orderFlows.js'
import { formatPkr } from './lib/payouts.js'

function OrderPage({ orderId }) {
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(null)
  const [returnReason, setReturnReason] = useState('')
  const [returnBusy, setReturnBusy] = useState(false)
  const [returnSuccess, setReturnSuccess] = useState('')
  const [returnError, setReturnError] = useState('')
  const [disputeBusy, setDisputeBusy] = useState(false)
  const [disputeSuccess, setDisputeSuccess] = useState('')
  const [disputeError, setDisputeError] = useState('')
  const [evidenceNote, setEvidenceNote] = useState('')
  const [evidenceUrl, setEvidenceUrl] = useState('')
  const [withdrawConfirm, setWithdrawConfirm] = useState(false)
  const [partyEvidence, setPartyEvidence] = useState([])
  const [reviewRating, setReviewRating] = useState('')
  const [reviewItemRating, setReviewItemRating] = useState('')
  const [reviewBody, setReviewBody] = useState('')
  const [reviewBusy, setReviewBusy] = useState(false)
  const [reviewSuccess, setReviewSuccess] = useState('')
  const [reviewError, setReviewError] = useState('')

  useEffect(() => {
    let active = true
    async function loadOrder() {
      try {
        if (!api.isAuthenticated()) {
          const session = await api.refresh()
          api.setAccessToken(session.accessToken)
        }
        const result = await api.getOrderSummary(orderId)
        if (active) setSummary(result)
      } catch (cause) {
        if (!active) return
        if (cause.status === 401 || cause.status === 403) {
          const returnTo = `${window.location.pathname}${window.location.search}`
          window.location.replace(`/login?${new URLSearchParams({ returnTo })}`)
          return
        }
        setError(getCheckoutError(cause).message)
      } finally {
        if (active) setLoading(false)
      }
    }
    loadOrder()
    return () => { active = false }
  }, [orderId])

  useEffect(() => {
    if (!summary || !['reserved', 'payment_pending'].includes(summary.status)) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [summary])

  useEffect(() => {
    let active = true
    if (!summary?.disputeId) {
      return undefined
    }
    api.getPartyDisputeEvidence(summary.disputeId)
      .then((result) => {
        if (active) setPartyEvidence(result?.items || [])
      })
      .catch(() => {
        if (active) setPartyEvidence([])
      })
    return () => { active = false }
  }, [summary?.disputeId])

  async function payNow() {
    setBusy(true)
    setError('')
    try {
      const payment = await api.createOrderPayment(orderId)
      const checkoutUrl = safeCheckoutRedirectUrl(payment.checkoutUrl, { production: import.meta.env?.PROD })
      if (!checkoutUrl) {
        setError('The payment provider returned an unsafe checkout link. No redirect was made.')
        return
      }
      window.location.assign(checkoutUrl)
    } catch (cause) {
      if (cause.status === 401 || cause.status === 403) {
        const returnTo = `${window.location.pathname}${window.location.search}`
        window.location.replace(`/login?${new URLSearchParams({ returnTo })}`)
        return
      }
      setError(getCheckoutError(cause).message)
    } finally {
      setBusy(false)
    }
  }

  async function cancelOrder() {
    if (!window.confirm(summary.status === 'funded' || summary.status === 'seller_preparing'
      ? 'Cancel this order and request a full refund?'
      : 'Cancel this reservation?')) return
    setBusy(true)
    setError('')
    try {
      await api.cancelReservationOrder(orderId)
      setSummary(await api.getOrderSummary(orderId))
    } catch (cause) {
      if (cause.status === 401 || cause.status === 403) {
        const returnTo = `${window.location.pathname}${window.location.search}`
        window.location.replace(`/login?${new URLSearchParams({ returnTo })}`)
        return
      }
      setError(getCheckoutError(cause).message)
    } finally {
      setBusy(false)
    }
  }

  async function refreshSummary() {
    setSummary(await api.getOrderSummary(orderId))
  }

  async function submitReturn(event) {
    event.preventDefault()
    if (returnBusy) return
    const reason = returnReason.trim()
    if (reason.length < 3 || reason.length > 500) {
      setReturnError('Return reason must be 3 to 500 characters.')
      setReturnSuccess('')
      return
    }
    setReturnBusy(true)
    setReturnError('')
    setReturnSuccess('')
    try {
      await api.fileReturnRequest(orderId, { reason })
      await refreshSummary()
      setReturnReason('')
      setReturnSuccess('Your return request was submitted.')
    } catch (cause) {
      setReturnError(getOrderFlowError(cause))
    } finally {
      setReturnBusy(false)
    }
  }

  async function submitDisputeEvidence(event) {
    event.preventDefault()
    if (disputeBusy || !summary?.disputeId) return
    const note = evidenceNote.trim()
    const link = evidenceUrl.trim()
    if (!note && !link) {
      setDisputeError('Add a text note or one HTTPS evidence link.')
      setDisputeSuccess('')
      return
    }
    if (note && (note.length < 3 || note.length > 500)) {
      setDisputeError('Evidence note must be 3 to 500 characters.')
      setDisputeSuccess('')
      return
    }
    setDisputeBusy(true)
    setDisputeError('')
    setDisputeSuccess('')
    try {
      if (note) await api.addDisputeEvidence(summary.disputeId, { note })
      else await api.addDisputeEvidence(summary.disputeId, { mediaReference: link })
      setEvidenceNote('')
      setEvidenceUrl('')
      await refreshSummary()
      setPartyEvidence((await api.getPartyDisputeEvidence(summary.disputeId))?.items || [])
      setDisputeSuccess('Your additional evidence was submitted.')
    } catch (cause) {
      setDisputeError(getOrderFlowError(cause))
    } finally {
      setDisputeBusy(false)
    }
  }

  async function withdrawDispute() {
    if (!withdrawConfirm) {
      setWithdrawConfirm(true)
      setDisputeError('')
      setDisputeSuccess('')
      return
    }
    if (disputeBusy || !summary?.disputeId) return
    setDisputeBusy(true)
    setDisputeError('')
    setDisputeSuccess('')
    try {
      await api.withdrawDispute(summary.disputeId)
      setWithdrawConfirm(false)
      await refreshSummary()
      setDisputeSuccess('The dispute was withdrawn.')
    } catch (cause) {
      setDisputeError(getOrderFlowError(cause))
    } finally {
      setDisputeBusy(false)
    }
  }

  async function submitReview(event) {
    event.preventDefault()
    if (reviewBusy) return
    const rating = Number(reviewRating)
    const itemRating = reviewItemRating ? Number(reviewItemRating) : null
    const body = reviewBody.trim()
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      setReviewError('Review rating must be an integer from 1 to 5.')
      setReviewSuccess('')
      return
    }
    if (itemRating !== null && (!Number.isInteger(itemRating) || itemRating < 1 || itemRating > 5)) {
      setReviewError('Item rating must be an integer from 1 to 5.')
      setReviewSuccess('')
      return
    }
    if (body && (body.length < 3 || body.length > 1000)) {
      setReviewError('Review comment must be 3 to 1000 characters.')
      setReviewSuccess('')
      return
    }
    setReviewBusy(true)
    setReviewError('')
    setReviewSuccess('')
    try {
      await api.submitOrderReview(orderId, {
        rating,
        ...(itemRating !== null ? { itemRating } : {}),
        ...(body ? { body } : {}),
      })
      setReviewRating('')
      setReviewItemRating('')
      setReviewBody('')
      await refreshSummary()
      setReviewSuccess('Your review was submitted.')
    } catch (cause) {
      setReviewError(getOrderFlowError(cause))
    } finally {
      setReviewBusy(false)
    }
  }

  if (loading) return <main className="route-loading" role="status">Loading your order…</main>
  if (!summary) {
    return (
      <main className="order-page">
        <section className="order-panel">
          <h1>Order unavailable</h1>
          {error && <p className="checkout-error" role="alert">{error}</p>}
          <a className="button button-secondary" href="/orders">My orders</a>
        </section>
      </main>
    )
  }

  const statusMessage = getOrderStatusMessage(summary)
  const unpaid = ['reserved', 'payment_pending'].includes(summary.status)
  const handedOver = ['handed_to_delivery', 'out_for_delivery', 'delivered', 'completed'].includes(summary.status)
  const canCancel = !handedOver && ['reserved', 'payment_pending', 'funded', 'seller_preparing'].includes(summary.status)
  const listingPath = `/listing/${encodeURIComponent(summary.listing.id)}`

  return (
    <main className="order-page">
      <section className="order-panel" aria-labelledby="order-title">
        <p className="eyebrow">Order status</p>
        <h1 id="order-title">{statusMessage.title}</h1>
        {error && <p className="checkout-error" role="alert">{error}</p>}
        <div className="order-listing">
          {summary.listing.imageUrl
            ? <img src={summary.listing.imageUrl} alt="" />
            : <div className="order-image-placeholder" aria-hidden="true">Poshaak</div>}
          <div>
            <h2>{summary.listing.title}</h2>
            <p>Order {summary.orderId}</p>
          </div>
        </div>
        <p className="order-status-copy" role="status">{statusMessage.message}</p>

        <dl className="order-amounts">
          <div><dt>Item price</dt><dd>{formatPkr(summary.itemPrice)}</dd></div>
          <div><dt>Delivery fee</dt><dd>{formatPkr(summary.deliveryFee)}</dd></div>
          <div><dt>Total</dt><dd>{formatPkr(summary.total)}</dd></div>
        </dl>

        <section className="order-address" aria-labelledby="delivery-address-title">
          <h2 id="delivery-address-title">Delivery address</h2>
          <p>{summary.address.recipientName}</p>
          <p>{summary.address.addressLine1}</p>
          <p>{summary.address.city}</p>
        </section>

        {unpaid && summary.reservation.expiresAt && (
          <p className="reservation-countdown" role="timer" aria-label="Time remaining in reservation">
            Reservation time remaining: {now === null ? 'Calculating…' : formatReservationCountdown(summary.reservation.expiresAt, now)}
          </p>
        )}
        {['funded', 'seller_preparing'].includes(summary.status) && summary.handoverDeadlineAt && (
          <p className="handover-deadline">Seller handover deadline: {new Date(summary.handoverDeadlineAt).toLocaleString()}</p>
        )}

        <div className="order-actions">
          {unpaid && <button className="button button-primary" type="button" onClick={payNow} disabled={busy}>
            {busy ? 'Please wait…' : 'Pay now'}
          </button>}
          {canCancel && <button className="button button-secondary" type="button" onClick={cancelOrder} disabled={busy}>
            {summary.status === 'funded' || summary.status === 'seller_preparing' ? 'Cancel and refund' : 'Cancel order'}
          </button>}
          {summary.disputeFiling?.canFileDispute && (
            <a className="button button-secondary" href={`/orders/${encodeURIComponent(orderId)}/report-problem`}>
              Report a problem
            </a>
          )}
          {['cancelled', 'expired'].includes(summary.status) && (
            <a className="button button-secondary" href={listingPath}>Return to listing</a>
          )}
          <a className="text-button" href="/orders">My orders</a>
        </div>

        <section className="seller-flow-section" aria-labelledby="return-title">
          <h2 id="return-title">Return</h2>
          {returnSuccess && <p className="seller-flow-success" role="status">{returnSuccess}</p>}
          {returnError && <p className="checkout-error" role="alert">{returnError}</p>}
          {summary.returnRequest && (
            <dl className="seller-flow-details">
              <div><dt>Status</dt><dd>{getReturnFlowLabel(summary.returnRequest.status)}</dd></div>
              {summary.returnRequest.reason && <div><dt>Your reason</dt><dd>{summary.returnRequest.reason}</dd></div>}
              {summary.returnRequest.sellerNote && <div><dt>Seller note</dt><dd>{summary.returnRequest.sellerNote}</dd></div>}
              {summary.returnRequest.createdAt && <div><dt>Requested</dt><dd>{new Date(summary.returnRequest.createdAt).toLocaleString()}</dd></div>}
              {summary.returnRequest.respondedAt && <div><dt>Seller response</dt><dd>{new Date(summary.returnRequest.respondedAt).toLocaleString()}</dd></div>}
              {summary.returnRequest.decidedAt && <div><dt>Decided</dt><dd>{new Date(summary.returnRequest.decidedAt).toLocaleString()}</dd></div>}
            </dl>
          )}
          {summary.returnFiling?.canRequestReturn && (
            <form className="seller-flow-form" onSubmit={submitReturn} noValidate>
              <label htmlFor="return-reason">Return reason (3 to 500 characters)</label>
              <textarea id="return-reason" value={returnReason} onChange={(event) => setReturnReason(event.currentTarget.value)} />
              <button className="button button-primary" type="submit" disabled={returnBusy}>
                {returnBusy ? 'Submitting…' : 'Request return'}
              </button>
            </form>
          )}
          {!summary.returnRequest && summary.status === 'completed' && !summary.returnFiling?.canRequestReturn &&
            <p className="muted-copy">A return can't be requested for this order right now.</p>}
        </section>

        <section className="seller-flow-section" aria-labelledby="dispute-title">
          <h2 id="dispute-title">Dispute</h2>
          {disputeSuccess && <p className="seller-flow-success" role="status">{disputeSuccess}</p>}
          {disputeError && <p className="checkout-error" role="alert">{disputeError}</p>}
          {summary.disputeFiling?.disputeStatus && (
            <>
              <dl className="seller-flow-details">
                <div><dt>Status</dt><dd>{getDisputeFlowLabel(summary.disputeFiling.disputeStatus)}</dd></div>
                {summary.disputeFiling.outcome && <div><dt>Outcome</dt><dd>{summary.disputeFiling.outcome}</dd></div>}
                {summary.disputeFiling.reason && <div><dt>Reason</dt><dd>{summary.disputeFiling.reason}</dd></div>}
                {summary.disputeFiling.decidedAt && <div><dt>Decided</dt><dd>{new Date(summary.disputeFiling.decidedAt).toLocaleString()}</dd></div>}
              </dl>
              {summary.disputeFiling.timeline?.length > 0 && (
                <ul className="seller-flow-timeline">
                  {summary.disputeFiling.timeline.map((item, index) => (
                    <li key={`${item.event}-${item.at}-${index}`}>{item.event}: {item.at ? new Date(item.at).toLocaleString() : 'Date unavailable'}</li>
                  ))}
                </ul>
              )}
            </>
          )}
          {summary.disputeActions?.canAddEvidence && (
            <form className="seller-flow-form" onSubmit={submitDisputeEvidence} noValidate>
              <label htmlFor="dispute-evidence-note">Evidence note (3 to 500 characters)</label>
              <textarea id="dispute-evidence-note" value={evidenceNote} onChange={(event) => {
                setEvidenceNote(event.currentTarget.value)
                setEvidenceUrl('')
                setDisputeError('')
              }} />
              <label htmlFor="dispute-evidence-url">Or one HTTPS evidence link</label>
              <input id="dispute-evidence-url" type="url" value={evidenceUrl} onChange={(event) => {
                setEvidenceUrl(event.currentTarget.value)
                setEvidenceNote('')
                setDisputeError('')
              }} />
              <button className="button button-primary" type="submit" disabled={disputeBusy}>
                {disputeBusy ? 'Submitting…' : 'Add evidence'}
              </button>
            </form>
          )}
          {summary.disputeActions?.canWithdraw && (
            <div>
              {!disputeSuccess && !disputeError && withdrawConfirm && <p role="status">Confirm again to withdraw this dispute.</p>}
              <button className="button button-secondary" type="button" onClick={withdrawDispute} disabled={disputeBusy}>
                {disputeBusy ? 'Withdrawing…' : withdrawConfirm ? 'Confirm withdrawal' : 'Withdraw dispute'}
              </button>
            </div>
          )}
          {partyEvidence.length > 0 && (
            <div>
              <h3>Your submitted evidence</h3>
              <ul className="seller-flow-evidence">
                {partyEvidence.filter((item) => item.submittedBy === 'buyer').map((item, index) => (
                  <li key={`${item.createdAt}-${index}`}>
                    {item.note && <span>{item.note}</span>}
                    {item.mediaReference && <a href={item.mediaReference} target="_blank" rel="noopener noreferrer">Evidence link</a>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {summary.deliveryOutcome && ['refused', 'lost'].includes(summary.deliveryOutcome.outcome) && (
          <section className="seller-flow-section" aria-labelledby="delivery-outcome-title">
            <h2 id="delivery-outcome-title">Delivery outcome</h2>
            <p>{getDeliveryOutcomeLabel(summary.deliveryOutcome)}</p>
          </section>
        )}

        <section className="seller-flow-section" aria-labelledby="review-title">
          <h2 id="review-title">Review the seller</h2>
          {reviewSuccess && <p className="seller-flow-success" role="status">{reviewSuccess}</p>}
          {reviewError && <p className="checkout-error" role="alert">{reviewError}</p>}
          {summary.myReview && (
            <>
              <p>{getReviewFlowLabel(summary.myReview)}</p>
              {summary.myReview.state === 'visible' && (
                <>
                  <p>{summary.myReview.rating} out of 5</p>
                  {summary.myReview.itemRating && <p>Item: {summary.myReview.itemRating} out of 5</p>}
                  {summary.myReview.body && <p>{summary.myReview.body}</p>}
                </>
              )}
            </>
          )}
          {!summary.myReview && summary.status === 'completed' && (
            <form className="seller-flow-form" onSubmit={submitReview} noValidate>
              <label htmlFor="review-rating">Rating (1 to 5)</label>
              <select id="review-rating" value={reviewRating} onChange={(event) => setReviewRating(event.currentTarget.value)}>
                <option value="">Choose a rating</option>
                {[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
              <label htmlFor="review-item-rating">Item rating (optional, 1 to 5)</label>
              <select id="review-item-rating" value={reviewItemRating} onChange={(event) => setReviewItemRating(event.currentTarget.value)}>
                <option value="">No item rating</option>
                {[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
              <label htmlFor="review-body">Comment (optional, 3 to 1000 characters)</label>
              <textarea id="review-body" value={reviewBody} onChange={(event) => setReviewBody(event.currentTarget.value)} />
              <button className="button button-primary" type="submit" disabled={reviewBusy}>
                {reviewBusy ? 'Submitting…' : 'Submit review'}
              </button>
            </form>
          )}
          {summary.reviewOfMe?.state === 'visible' && (
            <div>
              <h3>Seller review of you</h3>
              <p>{summary.reviewOfMe.rating} out of 5</p>
              {summary.reviewOfMe.body && <p>{summary.reviewOfMe.body}</p>}
            </div>
          )}
        </section>
      </section>
    </main>
  )
}

export default OrderPage
