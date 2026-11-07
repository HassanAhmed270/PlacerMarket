import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import { getCheckoutError } from './lib/checkout.js'
import {
  getSellerDisputeLabel,
  getSellerHandoverDeadline,
  getSellerOrderStatusMessage,
  getSellerPayoutLabel,
} from './lib/sellerOrders.js'

function SellerOrderPage({ orderId }) {
  const [order, setOrder] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [now, setNow] = useState(null)

  useEffect(() => {
    let active = true
    async function loadOrder() {
      try {
        if (!api.isAuthenticated()) {
          const session = await api.refresh()
          api.setAccessToken(session.accessToken)
        }
        const result = await api.getSellingOrder(orderId)
        if (active) {
          setNow(Date.now())
          setOrder(result)
        }
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
    : getSellerHandoverDeadline(order.handoverDeadlineAt, now)
  const disputeLabel = getSellerDisputeLabel(order.disputeStatus)

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
        <p className="seller-order-pickup-note">Handover is recorded by our team after courier pickup.</p>
        <a className="checkout-back-link" href="/seller/orders">Back to My sales</a>
      </section>
    </main>
  )
}

export default SellerOrderPage
