import { useCallback, useEffect, useState } from 'react'
import { api } from './lib/api.js'
import {
  getHeldFundsBanner,
  getSellerDisputeLabel,
  getSellerEarningsRows,
  getSellerHandoverDeadline,
  getSellerOrderStatusMessage,
  getSellerPayoutLabel,
  getSellerPayoutStatusLabel,
} from './lib/sellerOrders.js'
import {
  getDeliveryOutcomeLabel,
  getDisputeFlowLabel,
  getReviewFlowLabel,
  getReturnFlowLabel,
  getSellerFlowError,
  getSellerOrderAllowedActions,
} from './lib/orderFlows.js'

function SellerOrderPage({ orderId }) {
  const [orderResult, setOrderResult] = useState({ orderId: null, order: null })
  const [error, setError] = useState('')
  const [now, setNow] = useState(null)
  const [success, setSuccess] = useState('')
  const [busyAction, setBusyAction] = useState('')
  const [returnNote, setReturnNote] = useState('')
  const [counterResponse, setCounterResponse] = useState('')
  const [counterEvidenceUrl, setCounterEvidenceUrl] = useState('')
  const [evidenceNote, setEvidenceNote] = useState('')
  const [evidenceUrl, setEvidenceUrl] = useState('')
  const [partyEvidence, setPartyEvidence] = useState({ disputeId: null, items: [] })
  const [reviewRating, setReviewRating] = useState('')
  const [reviewBody, setReviewBody] = useState('')

  const order = orderResult.orderId === orderId ? orderResult.order : null
  const loading = orderResult.orderId !== orderId
  const visiblePartyEvidence = order?.disputeId === partyEvidence.disputeId
    ? partyEvidence.items
    : []

  const refreshOrder = useCallback(async () => {
    try {
      if (!api.isAuthenticated()) {
        const session = await api.refresh()
        api.setAccessToken(session.accessToken)
      }
      const result = await api.getSellingOrder(orderId)
      setNow(Date.now())
      setOrderResult({ orderId, order: result })
      setError('')
    } catch (cause) {
      if (cause?.status === 401 || cause?.status === 403) {
        const returnTo = `${window.location.pathname}${window.location.search}`
        window.location.replace(`/login?${new URLSearchParams({ returnTo })}`)
        return
      }
      setError(getSellerFlowError(cause))
    }
  }, [orderId])

  useEffect(() => {
    let active = true
    async function loadOrder() {
      try {
        if (!api.isAuthenticated()) {
          const session = await api.refresh()
          api.setAccessToken(session.accessToken)
        }
        const result = await api.getSellingOrder(orderId)
        if (!active) return
        setNow(Date.now())
        setOrderResult({ orderId, order: result })
        setError('')
      } catch (cause) {
        if (!active) return
        if (cause?.status === 401 || cause?.status === 403) {
          const returnTo = `${window.location.pathname}${window.location.search}`
          window.location.replace(`/login?${new URLSearchParams({ returnTo })}`)
          return
        }
        setOrderResult({ orderId, order: null })
        setError(getSellerFlowError(cause))
      }
    }
    loadOrder()
    return () => { active = false }
  }, [orderId])

  useEffect(() => {
    let active = true
    if (order?.disputeId) {
      api.getPartyDisputeEvidence(order.disputeId)
        .then((result) => {
          if (active) {
            setPartyEvidence({
              disputeId: order.disputeId,
              items: Array.isArray(result) ? result : [],
            })
          }
        })
        .catch((cause) => { if (active) setError(getSellerFlowError(cause)) })
    }
    return () => { active = false }
  }, [order?.disputeId])

  if (loading) return <main className="route-loading" role="status">Loading your sale…</main>
  if (!order) {
    return (
      <main className="seller-order-page">
        <section className="seller-order-panel">
          <h1>Order unavailable</h1>
          {error && <p className="checkout-error" role="alert">{error}</p>}
          <a className="checkout-back-link" href="/seller/orders">My sales</a>
        </section>
      </main>
    )
  }

  const status = getSellerOrderStatusMessage(order.status)
  const deadline = now === null
    ? null
    : getSellerHandoverDeadline(order.status, order.handoverDeadlineAt, now)
  const disputeLabel = getSellerDisputeLabel(order.disputeStatus)
  const earningsRows = getSellerEarningsRows(order)
  const payoutStatusLabel = getSellerPayoutStatusLabel(order.payout)
  const heldFundsBanner = getHeldFundsBanner(order)
  const allowedActions = getSellerOrderAllowedActions(order)

  async function respondToReturn(event) {
    event.preventDefault()
    if (busyAction || !order?.returnRequest?.id) return
    setBusyAction('return')
    setSuccess('')
    setError('')
    try {
      await api.respondToReturnRequest(order.returnRequest.id, returnNote)
      setSuccess('Your return response was sent. The Admin will decide the return.')
      await refreshOrder()
    } catch (cause) {
      setError(getSellerFlowError(cause))
    } finally {
      setBusyAction('')
    }
  }

  async function submitCounter(event) {
    event.preventDefault()
    if (busyAction || !order?.disputeId) return
    setBusyAction('counter')
    setSuccess('')
    setError('')
    try {
      await api.submitCounterEvidence(order.disputeId, {
        responseText: counterResponse,
        evidenceUrls: counterEvidenceUrl.trim() ? [counterEvidenceUrl.trim()] : [],
      })
      setSuccess('Your dispute response and evidence were submitted.')
      setCounterResponse('')
      setCounterEvidenceUrl('')
      await refreshOrder()
    } catch (cause) {
      setError(getSellerFlowError(cause))
    } finally {
      setBusyAction('')
    }
  }

  async function submitEvidence(event) {
    event.preventDefault()
    if (busyAction || !order?.disputeId) return
    setBusyAction('evidence')
    setSuccess('')
    setError('')
    try {
      if (evidenceNote.trim()) {
        await api.addDisputeEvidence(order.disputeId, { note: evidenceNote })
        setEvidenceNote('')
      } else {
        await api.addDisputeEvidence(order.disputeId, { mediaReference: evidenceUrl })
        setEvidenceUrl('')
      }
      setSuccess('Your additional evidence was submitted.')
      await refreshOrder()
    } catch (cause) {
      setError(getSellerFlowError(cause))
    } finally {
      setBusyAction('')
    }
  }

  async function submitReview(event) {
    event.preventDefault()
    if (busyAction || !allowedActions.includes('review_buyer')) return
    setBusyAction('review')
    setSuccess('')
    setError('')
    try {
      await api.submitOrderReview(orderId, {
        rating: Number(reviewRating),
        ...(reviewBody.trim() ? { body: reviewBody } : {}),
      })
      setSuccess('Your review was submitted.')
      setReviewRating('')
      setReviewBody('')
      await refreshOrder()
    } catch (cause) {
      setError(getSellerFlowError(cause))
    } finally {
      setBusyAction('')
    }
  }


  return (
    <main className="seller-order-page">
      <section className="seller-order-panel" aria-labelledby="seller-order-title">
        <p className="eyebrow">Sale status</p>
        <h1 id="seller-order-title">{status.title}</h1>
        {error && <p className="checkout-error" role="alert">{error}</p>}
        <div className="seller-order-listing">
          {order.imageUrl
            ? <img src={order.imageUrl} alt={order.title} />
            : <span className="seller-order-image-placeholder" aria-hidden="true">Poshaak</span>}
          <h2>{order.title}</h2>
        </div>
        <p className="seller-order-status-copy" role="status">{status.message}</p>
        <section className="seller-earnings-panel" aria-labelledby="seller-earnings-title">
          <h2 id="seller-earnings-title">Earnings and payout</h2>
          {earningsRows.length > 0
            ? <dl className="seller-earnings-details">
              {earningsRows.map((row) => (
                <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>
              ))}
            </dl>
            : <p role="status">Earnings not yet available.</p>}
          <p className="seller-payout-status">{payoutStatusLabel}</p>
          {heldFundsBanner && <p className="seller-held-funds-banner" role="status">{heldFundsBanner}</p>}
        </section>
        <dl className="seller-order-details">
          <div><dt>Item price</dt><dd>{order.currency} {order.itemPrice}</dd></div>
          <div><dt>Delivery city</dt><dd>{order.deliveryCity}</dd></div>
          {order.fundedAt && (
            <div>
              <dt>Funded</dt>
              <dd><time dateTime={order.fundedAt}>{new Date(order.fundedAt).toLocaleString()}</time></dd>
            </div>
          )}
          {deadline?.text && (
            <div>
              <dt>Handover deadline</dt>
              <dd>
                <time dateTime={order.handoverDeadlineAt}>{new Date(order.handoverDeadlineAt).toLocaleString()}</time>
                {deadline.overdue && <strong className="seller-order-overdue"> Overdue</strong>}
              </dd>
            </div>
          )}
          {order.handedOverAt && (
            <div>
              <dt>Handed over</dt>
              <dd><time dateTime={order.handedOverAt}>{new Date(order.handedOverAt).toLocaleString()}</time></dd>
            </div>
          )}
          {order.deliveredAt && (
            <div>
              <dt>Delivered</dt>
              <dd><time dateTime={order.deliveredAt}>{new Date(order.deliveredAt).toLocaleString()}</time></dd>
            </div>
          )}
          {order.cancelledAt && (
            <div>
              <dt>Cancelled</dt>
              <dd><time dateTime={order.cancelledAt}>{new Date(order.cancelledAt).toLocaleString()}</time></dd>
            </div>
          )}
          <div><dt>Payout</dt><dd>{getSellerPayoutLabel(order.payoutHoldState)}</dd></div>
          {disputeLabel && <div><dt>Dispute</dt><dd>{disputeLabel}</dd></div>}
        </dl>
        {success && <p className="seller-flow-success" role="status">{success}</p>}
        {order.deliveryOutcome && (
          <section className="seller-flow-section" aria-labelledby="delivery-outcome-title">
            <h2 id="delivery-outcome-title">Delivery outcome</h2>
            <p>{getDeliveryOutcomeLabel(order.deliveryOutcome)}</p>
            {order.deliveryOutcome.recordedAt && (
              <time dateTime={order.deliveryOutcome.recordedAt}>
                Recorded {new Date(order.deliveryOutcome.recordedAt).toLocaleString()}
              </time>
            )}
          </section>
        )}

        {order.returnRequest && (
          <section className="seller-flow-section" aria-labelledby="return-title">
            <h2 id="return-title">Return request</h2>
            <p>{getReturnFlowLabel(order.returnRequest.status)}</p>
            <dl className="seller-flow-details">
              <div><dt>Buyer reason</dt><dd>{order.returnRequest.reason || 'Reason unavailable'}</dd></div>
              {order.returnRequest.sellerNote && <div><dt>Your response</dt><dd>{order.returnRequest.sellerNote}</dd></div>}
              {order.returnRequest.createdAt && <div><dt>Requested</dt><dd><time dateTime={order.returnRequest.createdAt}>{new Date(order.returnRequest.createdAt).toLocaleString()}</time></dd></div>}
              {order.returnRequest.respondedAt && <div><dt>Responded</dt><dd><time dateTime={order.returnRequest.respondedAt}>{new Date(order.returnRequest.respondedAt).toLocaleString()}</time></dd></div>}
              {order.returnRequest.decidedAt && <div><dt>Decided</dt><dd><time dateTime={order.returnRequest.decidedAt}>{new Date(order.returnRequest.decidedAt).toLocaleString()}</time></dd></div>}
            </dl>
            {allowedActions.includes('respond_to_return') && (
              <form className="seller-flow-form" onSubmit={respondToReturn}>
                <label htmlFor="return-note">Your response note</label>
                <textarea id="return-note" required minLength={3} maxLength={300} value={returnNote} onChange={(event) => {
                  setReturnNote(event.currentTarget.value)
                  setError('')
                }} />
                <button className="button button-primary" type="submit" disabled={busyAction === 'return'}>
                  {busyAction === 'return' ? 'Sending…' : 'Send response'}
                </button>
              </form>
            )}
          </section>
        )}

        {order.disputeStatus && (
          <section className="seller-flow-section" aria-labelledby="dispute-title">
            <h2 id="dispute-title">Dispute</h2>
            <p>{getDisputeFlowLabel(order.disputeStatus)}</p>
            {order.disputeReason && <p><strong>Resolution reason:</strong> {order.disputeReason}</p>}
            {order.disputeDecidedAt && (
              <p>Decided <time dateTime={order.disputeDecidedAt}>{new Date(order.disputeDecidedAt).toLocaleString()}</time></p>
            )}
            {Array.isArray(order.disputeTimeline) && order.disputeTimeline.length > 0 && (
              <ul className="seller-flow-timeline">
                {order.disputeTimeline.map((item, index) => (
                  <li key={`${item.event}-${item.at}-${index}`}>
                    {item.event.replaceAll('_', ' ')}
                    {item.at && <> — <time dateTime={item.at}>{new Date(item.at).toLocaleString()}</time></>}
                  </li>
                ))}
              </ul>
            )}
            {allowedActions.includes('submit_counter_evidence') && (
              <form className="seller-flow-form" onSubmit={submitCounter}>
                <label htmlFor="counter-response">Your response</label>
                <textarea id="counter-response" value={counterResponse} onChange={(event) => setCounterResponse(event.currentTarget.value)} />
                <label htmlFor="counter-evidence">Evidence HTTPS link (optional)</label>
                <input id="counter-evidence" type="url" value={counterEvidenceUrl} onChange={(event) => setCounterEvidenceUrl(event.currentTarget.value)} />
                <button className="button button-primary" type="submit" disabled={busyAction === 'counter'}>
                  {busyAction === 'counter' ? 'Submitting…' : 'Submit counter-evidence'}
                </button>
              </form>
            )}
            {allowedActions.includes('add_dispute_evidence') && (
              <form className="seller-flow-form" onSubmit={submitEvidence}>
                <label htmlFor="evidence-note">Additional text evidence (3 to 500 characters)</label>
                <textarea id="evidence-note" value={evidenceNote} onChange={(event) => {
                  setEvidenceNote(event.currentTarget.value)
                  setEvidenceUrl('')
                }} />
                <label htmlFor="evidence-url">Or an HTTPS evidence link</label>
                <input id="evidence-url" type="url" value={evidenceUrl} onChange={(event) => {
                  setEvidenceUrl(event.currentTarget.value)
                  setEvidenceNote('')
                }} />
                <button className="button button-primary" type="submit" disabled={busyAction === 'evidence'}>
                  {busyAction === 'evidence' ? 'Submitting…' : 'Add evidence'}
                </button>
              </form>
            )}
            {visiblePartyEvidence.length > 0 && (
              <div>
                <h3>Your submitted evidence</h3>
                <ul className="seller-flow-evidence">
                  {visiblePartyEvidence.filter((item) => item.submittedBy === 'seller').map((item, index) => (
                    <li key={`${item.createdAt}-${index}`}>
                      {item.note && <span>{item.note}</span>}
                      {item.mediaReference && (
                        /^https:\/\//.test(item.mediaReference)
                          ? <a href={item.mediaReference} target="_blank" rel="noopener noreferrer">Evidence link</a>
                          : <span>Evidence link unavailable</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        {allowedActions.includes('review_buyer') && (
          <section className="seller-flow-section" aria-labelledby="review-title">
            <h2 id="review-title">Review the buyer</h2>
            <form className="seller-flow-form" onSubmit={submitReview}>
              <label htmlFor="review-rating">Rating</label>
              <select id="review-rating" required value={reviewRating} onChange={(event) => setReviewRating(event.currentTarget.value)}>
                <option value="">Select 1 to 5</option>
                {[1, 2, 3, 4, 5].map((rating) => <option key={rating} value={rating}>{rating}</option>)}
              </select>
              <label htmlFor="review-body">Comment (optional)</label>
              <textarea id="review-body" minLength={3} maxLength={1000} value={reviewBody} onChange={(event) => setReviewBody(event.currentTarget.value)} />
              <button className="button button-primary" type="submit" disabled={busyAction === 'review'}>
                {busyAction === 'review' ? 'Submitting…' : 'Submit review'}
              </button>
            </form>
          </section>
        )}
        {order.myReview && (
          <section className="seller-flow-section" aria-labelledby="my-review-title">
            <h2 id="my-review-title">Your review</h2>
            <p>{getReviewFlowLabel(order.myReview)}</p>
            {order.myReview.state === 'visible' && (
              <><p>{order.myReview.rating} out of 5</p>{order.myReview.body && <p>{order.myReview.body}</p>}</>
            )}
          </section>
        )}
        {order.reviewOfMe && (
          <section className="seller-flow-section" aria-labelledby="received-review-title">
            <h2 id="received-review-title">Buyer review of you</h2>
            <p>{getReviewFlowLabel(order.reviewOfMe)}</p>
            {order.reviewOfMe.state === 'visible' && (
              <><p>{order.reviewOfMe.rating} out of 5</p>{order.reviewOfMe.body && <p>{order.reviewOfMe.body}</p>}</>
            )}
          </section>
        )}
        <p className="seller-order-pickup-note">Handover is recorded by our team after courier pickup.</p>
        <a className="checkout-back-link" href="/seller/orders">Back to My sales</a>
      </section>
    </main>
  )
}

export default SellerOrderPage
