import { useState } from 'react'
import { api } from './lib/api.js'
import {
  adminErrorMessage,
  buildManualRefundRequestPayload,
  formatAdminAmount,
  validateManualRefundReason,
} from './lib/admin.js'

export default function AdminRefundRequest() {
  const [orderId, setOrderId] = useState(() => new URLSearchParams(window.location.search).get('orderId') || '')
  const [reason, setReason] = useState('')
  const [authenticatorCode, setAuthenticatorCode] = useState('')
  const [balance, setBalance] = useState(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function loadBalance() {
    if (!orderId.trim()) {
      setError('Enter an order ID.')
      return
    }
    setPending(true)
    setError('')
    setNotice('')
    try {
      setBalance(await api.getAdminRefundableBalance(orderId.trim()))
    } catch (cause) {
      setBalance(null)
      setError(adminErrorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  async function submit(event) {
    event.preventDefault()
    const validation = validateManualRefundReason(reason)
    if (validation) {
      setError(validation)
      return
    }
    setPending(true)
    setError('')
    setNotice('')
    try {
      const stepUp = await api.createStepUpGrant('refund.request', authenticatorCode)
      const result = await api.requestAdminManualRefund(
        orderId.trim(),
        buildManualRefundRequestPayload(reason, stepUp.grant),
      )
      setNotice(`Request ${result.refundId} was created for the full refundable balance.`)
      setAuthenticatorCode('')
      setBalance(null)
    } catch (cause) {
      setError(adminErrorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <section>
      <p className="admin-eyebrow">Payments</p>
      <p><a href="/admin/refunds">← Manual refunds</a></p>
      <h1>Request a full refund</h1>
      <p>Partial refunds are not available here. The server calculates the full refundable balance; this form does not send an amount.</p>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {notice && <p className="admin-notice" role="status">{notice}</p>}
      <div className="admin-card">
        <div className="admin-form">
          <label>Order ID
            <input value={orderId} onChange={(event) => { setOrderId(event.target.value); setBalance(null) }} required />
          </label>
          <button className="admin-button" type="button" onClick={loadBalance} disabled={pending}>
            {pending ? 'Checking…' : 'Check refundable balance'}
          </button>
          {balance && <p><strong>Full refundable balance:</strong> {formatAdminAmount(balance.refundableAmount.total, balance.currency)}</p>}
          {balance && <form className="admin-form" onSubmit={submit}>
            <label>Reason (20–1000 characters)
              <textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={20} maxLength={1000} required />
            </label>
            <label>Authenticator code
              <input value={authenticatorCode} onChange={(event) => setAuthenticatorCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required />
            </label>
            <button className="admin-button admin-button-primary" type="submit" disabled={pending || !balance}>
              {pending ? 'Submitting…' : 'Request full refund'}
            </button>
          </form>}
        </div>
      </div>
    </section>
  )
}
