import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import { getCheckoutError, getOrderStatusMessage, PAYMENT_POLL_INTERVAL_MS, PAYMENT_POLL_MAX_DURATION_MS, shouldStopPaymentPolling } from './lib/checkout.js'
import { schedulePolling } from './lib/polling.js'

function PaymentReturnPage({ orderId }) {
  const [summary, setSummary] = useState(null)
  const [error, setError] = useState('')
  const [timedOut, setTimedOut] = useState(false)

  useEffect(() => {
    let active = true
    let stopPolling = () => {}
    let timeout
    let stopped = false
    const startedAt = Date.now()
    function stop() {
      if (stopped) return
      stopped = true
      stopPolling()
      window.clearTimeout(timeout)
    }

    async function poll() {
      try {
        const result = await api.getOrderSummary(orderId)
        if (!active || stopped) return
        setSummary(result)
        setError('')
        if (shouldStopPaymentPolling(result, startedAt)) stop()
      } catch (cause) {
        if (!active || stopped) return
        if (cause.status === 401 || cause.status === 403) {
          stop()
          const returnTo = `${window.location.pathname}${window.location.search}`
          window.location.replace(`/login?${new URLSearchParams({ returnTo })}`)
          return
        }
        setError(getCheckoutError(cause).message)
        if (cause.status === 404) stop()
      }
    }

    async function start() {
      try {
        if (!api.isAuthenticated()) {
          const session = await api.refresh()
          api.setAccessToken(session.accessToken)
        }
      } catch (cause) {
        if (!active) return
        if (cause.status === 401 || cause.status === 403) {
          const returnTo = `${window.location.pathname}${window.location.search}`
          window.location.replace(`/login?${new URLSearchParams({ returnTo })}`)
          return
        }
        setError(getCheckoutError(cause).message)
      }
      if (!active) return
      timeout = window.setTimeout(() => {
        setTimedOut(true)
        stop()
      }, PAYMENT_POLL_MAX_DURATION_MS)
      stopPolling = schedulePolling(poll, PAYMENT_POLL_INTERVAL_MS)
      poll()
    }

    start()
    return () => {
      active = false
      stop()
    }
  }, [orderId])

  const status = summary ? getOrderStatusMessage(summary) : null
  const failed = summary && status.title === 'Payment failed'

  return (
    <main className="payment-return-page">
      <section className="order-panel" aria-labelledby="payment-return-title">
        <p className="eyebrow">Payment update</p>
        <h1 id="payment-return-title">{status?.title || 'Confirming your payment'}</h1>
        {!status?.final && <p role="status">Checking the payment status with the marketplace. Returning from checkout does not confirm payment.</p>}
        {status?.message && <p className="order-status-copy" role="status">{status.message}</p>}
        {error && <p className="checkout-error" role="alert">{error}</p>}
        {timedOut && !status?.final && <p className="checkout-error" role="status">Payment is still unconfirmed. Check the order status again shortly.</p>}
        {failed && <a className="button button-primary" href={`/orders/${encodeURIComponent(orderId)}`}>Retry payment</a>}
        {(status?.final || timedOut || error) && <a className="text-button" href={`/orders/${encodeURIComponent(orderId)}`}>View order</a>}
      </section>
    </main>
  )
}

export default PaymentReturnPage
