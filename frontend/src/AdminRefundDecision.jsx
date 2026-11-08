import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import {
  adminErrorMessage,
  adminStatusLabel,
  canDecideManualRefund,
  formatAdminAmount,
  formatAdminDate,
  manualRefundExpiryLabel,
  validateManualRefundReason,
} from './lib/admin.js'

export default function AdminRefundDecision({ refundId }) {
  const [refund, setRefund] = useState(null)
  const [reason, setReason] = useState('')
  const [authenticatorCode, setAuthenticatorCode] = useState('')
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let active = true
    api.getAdminManualRefund(refundId).then((result) => {
      if (active) setRefund(result)
    }).catch((cause) => {
      if (active) setError(adminErrorMessage(cause))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [refundId])

  async function decide(decision) {
    const validation = validateManualRefundReason(reason)
    if (validation) {
      setError(validation)
      return
    }
    setPending(true)
    setError('')
    setNotice('')
    try {
      const stepUp = await api.createStepUpGrant('refund.decide', authenticatorCode)
      const result = await api.decideAdminManualRefund(refundId, decision, {
        reason: reason.trim(),
        stepUpGrant: stepUp.grant,
      })
      setRefund((current) => ({ ...current, status: result.status, decisionNote: reason.trim() }))
      setNotice(`Refund request ${result.status}.`)
      setAuthenticatorCode('')
    } catch (cause) {
      setError(adminErrorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  if (loading) return <p className="admin-loading" role="status">Loading refund request…</p>
  if (!refund) return <p className="admin-error" role="alert">{error || 'Refund request unavailable.'}</p>

  return (
    <section>
      <p className="admin-eyebrow">Payments</p>
      <p><a href="/admin/refunds">← Manual refunds</a></p>
      <h1>Manual refund decision</h1>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {notice && <p className="admin-notice" role="status">{notice}</p>}
      <article className="admin-card admin-row">
        <p><strong>Status:</strong> {adminStatusLabel(refund.status)}</p>
        <p><strong>Order:</strong> <a href={`/admin/orders/${encodeURIComponent(refund.orderId)}`}>{refund.orderId}</a></p>
        <p><strong>Amount:</strong> {formatAdminAmount(refund.amount, refund.currency)}</p>
        <p><strong>Requested by:</strong> {refund.requestedBy}</p>
        <p><strong>Requested:</strong> {formatAdminDate(refund.requestedAt)}</p>
        <p><strong>Expiry:</strong> {refund.status === 'expired'
          ? 'Expired'
          : refund.status === 'requested' ? manualRefundExpiryLabel(refund.expiresAt) : '—'}</p>
        <p><strong>Request reason:</strong> {refund.reason}</p>
        {refund.decisionNote && <p><strong>Decision note:</strong> {refund.decisionNote}</p>}
      </article>
      {refund.requestedByMe && refund.status === 'requested'
        ? <p className="admin-warning" role="status">You requested this refund and cannot approve or reject it. A different Admin must decide.</p>
        : refund.status === 'requested' && !canDecideManualRefund(refund)
          ? <p className="admin-warning" role="status">This refund request has expired and cannot be decided.</p>
          : canDecideManualRefund(refund) && <div className="admin-card admin-form">
          <label>Decision reason (20–1000 characters)
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={20} maxLength={1000} required />
          </label>
          <label>Authenticator code
            <input value={authenticatorCode} onChange={(event) => setAuthenticatorCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required />
          </label>
          <div className="admin-filter">
            <button className="admin-button admin-button-primary" type="button" onClick={() => decide('approve')} disabled={pending}>{pending ? 'Saving…' : 'Approve'}</button>
            <button className="admin-button" type="button" onClick={() => decide('reject')} disabled={pending}>{pending ? 'Saving…' : 'Reject'}</button>
          </div>
        </div>}
    </section>
  )
}
