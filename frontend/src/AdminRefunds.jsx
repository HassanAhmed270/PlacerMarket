import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import {
  adminErrorMessage,
  adminStatusLabel,
  formatAdminAmount,
  formatAdminDate,
  manualRefundAgeLabel,
  manualRefundExpiryLabel,
} from './lib/admin.js'

export default function AdminRefunds() {
  const [refunds, setRefunds] = useState([])
  const [needsAttention, setNeedsAttention] = useState([])
  const [nextBefore, setNextBefore] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadingNeedsAttention, setLoadingNeedsAttention] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    api.getAdminManualRefunds({ limit: 20 }).then((result) => {
      if (!active) return
      setRefunds(result.refunds || [])
      setNextBefore(result.nextBefore || null)
    }).catch((cause) => {
      if (active) setError(adminErrorMessage(cause))
    }).finally(() => {
      if (active) setLoading(false)
    })
    api.getAdminRefundsNeedingAttention({ limit: 20 }).then((result) => {
      if (!active) return
      setNeedsAttention(result.refunds || [])
    }).catch((cause) => {
      if (active) setError((current) => current || adminErrorMessage(cause))
    }).finally(() => {
      if (active) setLoadingNeedsAttention(false)
    })
    return () => { active = false }
  }, [reload])

  async function loadMore() {
    if (!nextBefore || loadingMore) return
    setLoadingMore(true)
    setError('')
    try {
      const result = await api.getAdminManualRefunds({ limit: 20, before: nextBefore })
      setRefunds((current) => [...current, ...(result.refunds || [])])
      setNextBefore(result.nextBefore || null)
    } catch (cause) {
      setError(adminErrorMessage(cause))
    } finally {
      setLoadingMore(false)
    }
  }

  async function retryRefund(refundId) {
    if (!window.confirm('Retry this failed refund now?')) return
    try {
      await api.retryAdminFailedRefund(refundId)
      setNeedsAttention((current) => current.filter((refund) => refund.refundId !== refundId))
      setError('')
    } catch (cause) {
      setError(adminErrorMessage(cause))
    }
  }

  return (
    <section>
      <div className="admin-toolbar">
        <div><p className="admin-eyebrow">Payments</p><h1>Manual refunds</h1></div>
        <a className="admin-button admin-button-primary" href="/admin/refunds/request">Request full refund</a>
      </div>
      {error && <><p className="admin-error" role="alert">{error}</p><button className="admin-button" type="button" onClick={() => { setLoading(true); setError(''); setReload((value) => value + 1) }}>Retry</button></>}
      <section className="admin-card">
        <h2>Needs attention</h2>
        {loadingNeedsAttention ? <p role="status">Loading failed refunds…</p> : needsAttention.length === 0
          ? <p role="status">No failed refunds need attention.</p>
          : <div className="admin-list">
            {needsAttention.map((refund) => (
              <article className="admin-card admin-row" key={refund.refundId}>
                <p><strong>Order:</strong> <a href={`/admin/orders/${encodeURIComponent(refund.orderId)}`}>{refund.orderId}</a></p>
                <p><strong>Trigger:</strong> {refund.trigger}</p>
                <p><strong>Amount:</strong> {formatAdminAmount(refund.amount, refund.currency)}</p>
                <p><strong>Attempts:</strong> {refund.attemptCount}</p>
                <p><strong>Last error:</strong> {refund.lastErrorCode || 'unknown'}</p>
                <p><strong>Last attempt:</strong> {formatAdminDate(refund.lastAttemptAt)}</p>
                <p><strong>Needs attention:</strong> {formatAdminDate(refund.needsAttentionAt)}</p>
                <button className="admin-button admin-button-primary" type="button" onClick={() => retryRefund(refund.refundId)}>
                  Retry
                </button>
              </article>
            ))}
          </div>}
      </section>
      {loading ? <p role="status">Loading manual refunds…</p> : error ? null : refunds.length === 0
        ? <p role="status">No manual refund requests found.</p>
        : <div className="admin-list">
          {refunds.map((refund) => (
            <article className="admin-card admin-row" key={refund.refundId}>
              <h2><a href={`/admin/refunds/${encodeURIComponent(refund.refundId)}`}>Refund request</a></h2>
              <p><strong>Status:</strong> {adminStatusLabel(refund.status)}</p>
              <p><strong>Order:</strong> <a href={`/admin/orders/${encodeURIComponent(refund.orderId)}`}>{refund.orderId}</a></p>
              <p><strong>Amount:</strong> {formatAdminAmount(refund.amount, refund.currency)}</p>
              <p><strong>Requested by:</strong> {refund.requestedBy}</p>
              <p><strong>Age:</strong> {manualRefundAgeLabel(refund.requestedAt)}</p>
              <p><strong>Expiry:</strong> {refund.status === 'expired'
                ? 'Expired'
                : refund.status === 'requested' ? manualRefundExpiryLabel(refund.expiresAt) : '—'}</p>
              <p><strong>Requested:</strong> {formatAdminDate(refund.requestedAt)}</p>
            </article>
          ))}
        </div>}
      {nextBefore && !loading && (
        <div className="admin-pagination">
          <button className="admin-button" type="button" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </section>
  )
}
