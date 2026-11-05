import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import {
  formatReservationCountdown,
  getCheckoutError,
  getOrderStatusMessage,
  safeCheckoutRedirectUrl,
} from './lib/checkout.js'

function OrderPage({ orderId }) {
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
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
          <div><dt>Item price</dt><dd>{summary.currency} {summary.itemPrice}</dd></div>
          <div><dt>Delivery fee</dt><dd>{summary.currency} {summary.deliveryFee}</dd></div>
          <div><dt>Total</dt><dd>{summary.currency} {summary.total}</dd></div>
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
          {['cancelled', 'expired'].includes(summary.status) && (
            <a className="button button-secondary" href={listingPath}>Return to listing</a>
          )}
          <a className="text-button" href="/orders">My orders</a>
        </div>
      </section>
    </main>
  )
}

export default OrderPage
