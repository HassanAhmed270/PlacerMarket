import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import { getCheckoutError } from './lib/checkout.js'
import {
  getSellerHandoverDeadline,
  getSellerOrderStatusMessage,
} from './lib/sellerOrders.js'

const PAGE_SIZE = 20

function SellerOrdersPage() {
  const [orders, setOrders] = useState([])
  const [nextBefore, setNextBefore] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(null)

  useEffect(() => {
    let active = true
    async function loadOrders() {
      try {
        if (!api.isAuthenticated()) {
          const session = await api.refresh()
          api.setAccessToken(session.accessToken)
        }
        const result = await api.getSellingOrders({ limit: PAGE_SIZE })
        if (!active) return
        setNow(Date.now())
        setOrders(result.orders)
        setNextBefore(result.nextBefore)
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

  async function loadMore() {
    if (!nextBefore || loadingMore) return
    setLoadingMore(true)
    setError('')
    try {
      const result = await api.getSellingOrders({ limit: PAGE_SIZE, before: nextBefore })
      setOrders((current) => [...current, ...result.orders])
      setNextBefore(result.nextBefore)
    } catch (cause) {
      if (cause.status === 401 || cause.status === 403) {
        const returnTo = `${window.location.pathname}${window.location.search}`
        window.location.replace(`/login?${new URLSearchParams({ returnTo })}`)
        return
      }
      setError(getCheckoutError(cause).message)
    } finally {
      setLoadingMore(false)
    }
  }

  if (loading) return <main className="route-loading" role="status">Loading your sales…</main>

  return (
    <main className="seller-orders-page">
      <p className="eyebrow">Your account</p>
      <h1>My sales</h1>
      {error && <p className="checkout-error" role="alert">{error}</p>}
      {!error && orders.length === 0 && <p className="empty-orders">You have no funded orders yet.</p>}
      {orders.length > 0 && (
        <ol className="seller-orders-list">
          {orders.map((order) => {
            const status = getSellerOrderStatusMessage(order.status)
            const deadline = now === null
              ? null
              : getSellerHandoverDeadline(order.handoverDeadlineAt, now)
            return (
              <li key={order.orderId}>
                <a href={`/seller/orders/${encodeURIComponent(order.orderId)}`}>
                  {order.imageUrl
                    ? <img src={order.imageUrl} alt={order.title} />
                    : <span className="seller-order-image-placeholder" aria-hidden="true">Poshaak</span>}
                  <span className="seller-order-summary">
                    <span className="seller-order-title">{order.title}</span>
                    <span>{status.title}</span>
                    <span>{order.currency} {order.itemPrice}</span>
                    <span>{order.deliveryCity}</span>
                    {order.fundedAt && (
                      <time dateTime={order.fundedAt}>
                        Funded {new Date(order.fundedAt).toLocaleDateString()}
                      </time>
                    )}
                    {deadline?.text && (
                      <span>
                        {deadline.text}{deadline.overdue && <strong className="seller-order-overdue"> Overdue</strong>}
                      </span>
                    )}
                  </span>
                </a>
              </li>
            )
          })}
        </ol>
      )}
      {nextBefore && (
        <div className="seller-orders-pagination">
          <button type="button" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </main>
  )
}

export default SellerOrdersPage
