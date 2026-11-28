import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import { getCheckoutError, getOrderStatusMessage } from './lib/checkout.js'
import {
  getDeliveryOutcomeLabel,
  getDisputeFlowLabel,
  getReturnFlowLabel,
  getReviewFlowLabel,
} from './lib/orderFlows.js'
import { formatPkr } from './lib/payouts.js'
import { formatPakistanDate } from './lib/pakistanTime.js'

function MyOrdersPage() {
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    async function loadOrders() {
      try {
        if (!api.isAuthenticated()) {
          const session = await api.refresh()
          api.setAccessToken(session.accessToken)
        }
        const result = await api.getMyOrders({ limit: 20 })
        if (active) setOrders(result)
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
    loadOrders()
    return () => { active = false }
  }, [])

  if (loading) return <main className="route-loading" role="status">Loading your orders…</main>

  return (
    <main className="my-orders-page">
      <p className="eyebrow">Your account</p>
      <h1>My orders</h1>
      {error && <p className="checkout-error" role="alert">{error}</p>}
      {!error && orders.length === 0 && <p className="empty-orders">You have no reservation-backed orders yet.</p>}
      {orders.length > 0 && (
        <ol className="my-orders-list">
          {orders.map((order) => {
            const status = getOrderStatusMessage({ status: order.status })
            return (
              <li key={order.orderId}>
                <a href={`/orders/${encodeURIComponent(order.orderId)}`}>
                  <span className="my-order-title">{order.title}</span>
                  <span>{status.title}</span>
                  <span>{formatPkr(order.total)}</span>
                  {order.returnRequest?.status && (
                    <span className="seller-flow-badge">{getReturnFlowLabel(order.returnRequest.status)}</span>
                  )}
                  {order.disputeId && (
                    <span className="seller-flow-badge">
                      {getDisputeFlowLabel(order.disputeStatus)}
                    </span>
                  )}
                  {order.deliveryOutcome && ['refused', 'lost'].includes(order.deliveryOutcome.outcome) && (
                    <span className="seller-flow-badge">{getDeliveryOutcomeLabel(order.deliveryOutcome)}</span>
                  )}
                  {order.status === 'completed' && (
                    <span className="seller-flow-badge">
                      {order.myReview
                        ? getReviewFlowLabel(order.myReview)
                        : 'Review the seller'}
                    </span>
                  )}
                  <span className="my-order-date">{formatPakistanDate(order.createdAt)}</span>
                </a>
              </li>
            )
          })}
        </ol>
      )}
    </main>
  )
}

export default MyOrdersPage
