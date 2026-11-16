import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import {
  adminErrorMessage,
  formatAdminDate,
} from './lib/admin.js'
import {
  canApprove,
  canMarkFailed,
  canMarkPaid,
  canRetry,
  formatPkr,
  payoutStatusLabel,
  validateFailedForm,
  validatePaidForm,
} from './lib/payouts.js'

function localToday() {
  const date = new Date()
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function fieldValue(value) {
  return value === null || value === undefined || value === '' ? '—' : value
}

export default function AdminSellerPayoutDetail({ payoutId, currentAdminId }) {
  const [payout, setPayout] = useState(null)
  const [paidForm, setPaidForm] = useState({
    method: 'bank',
    transferReference: '',
    paidOn: localToday(),
    note: '',
  })
  const [failureReason, setFailureReason] = useState('')
  const [codes, setCodes] = useState({ approve: '', paid: '', failed: '', retry: '' })
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    api.getAdminSellerPayout(payoutId).then((result) => {
      if (active) setPayout(result)
    }).catch((cause) => {
      if (active) setError(adminErrorMessage(cause))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [payoutId, reload])

  function updatePaidForm(name, value) {
    setPaidForm((current) => ({ ...current, [name]: value }))
  }

  async function performAction({ name, action, successMessage, request }) {
    const code = codes[name]
    if (!code.trim()) {
      setError('Enter your authenticator code to continue.')
      return
    }
    setPending(name)
    setError('')
    setNotice('')
    try {
      const stepUp = await api.createStepUpGrant(action, code)
      await request(stepUp.grant)
      setNotice(successMessage)
      setLoading(true)
      setReload((current) => current + 1)
    } catch (cause) {
      setError(adminErrorMessage(cause))
    } finally {
      setCodes((current) => ({ ...current, [name]: '' }))
      setPending('')
    }
  }

  function submitPaid(event) {
    event.preventDefault()
    const validation = validatePaidForm({ ...paidForm, today: localToday() })
    if (validation) {
      setError(validation)
      return
    }
    performAction({
      name: 'paid',
      action: 'payout.record',
      successMessage: 'Payout marked paid.',
      request: (stepUpGrant) => api.markAdminSellerPayoutPaid(payoutId, {
        method: paidForm.method,
        transferReference: paidForm.transferReference.trim(),
        paidOn: paidForm.paidOn,
        note: paidForm.note.trim() || undefined,
        stepUpGrant,
      }),
    })
  }

  function submitFailed(event) {
    event.preventDefault()
    const validation = validateFailedForm({ reason: failureReason })
    if (validation) {
      setError(validation)
      return
    }
    performAction({
      name: 'failed',
      action: 'payout.record',
      successMessage: 'Payout marked failed.',
      request: (stepUpGrant) => api.markAdminSellerPayoutFailed(payoutId, {
        reason: failureReason.trim(),
        stepUpGrant,
      }),
    })
  }

  if (loading) return <p className="admin-loading" role="status">Loading seller payout…</p>
  if (!payout) {
    return (
      <section>
        <p><a href="/admin/seller-payouts">Back to seller payouts</a></p>
        <p className="admin-error" role="alert">{error || 'Seller payout unavailable.'}</p>
        <button className="admin-button" type="button" onClick={() => {
          setLoading(true)
          setError('')
          setReload((current) => current + 1)
        }}>Retry</button>
      </section>
    )
  }

  const approvalAllowed = canApprove({ payout, currentAdminId })
  const paymentAllowed = canMarkPaid({ payout })
  const failureAllowed = canMarkFailed({ payout })
  const retryAllowed = canRetry({ payout })

  return (
    <section>
      <p className="admin-eyebrow">Payments</p>
      <p><a href="/admin/seller-payouts">← Seller payouts</a></p>
      <h1>Seller payout detail</h1>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {notice && <p className="admin-notice" role="status">{notice}</p>}
      <article className="admin-card admin-payout-detail">
        <dl className="admin-data-grid">
          <div><dt>Payout ID</dt><dd>{payout.id}</dd></div>
          <div><dt>Order</dt><dd><a href={`/admin/orders/${encodeURIComponent(payout.orderId)}`}>{payout.orderId}</a></dd></div>
          <div><dt>Seller ID</dt><dd>{payout.sellerId}</dd></div>
          <div><dt>Attempt</dt><dd>{fieldValue(payout.attempt)}</dd></div>
          <div><dt>Status</dt><dd>{payoutStatusLabel(payout.status)}</dd></div>
          <div><dt>Amount</dt><dd>{formatPkr(payout.amount)}</dd></div>
          <div><dt>Currency</dt><dd>{fieldValue(payout.currency)}</dd></div>
          <div><dt>Initiated by</dt><dd>{fieldValue(payout.initiatedBy)}</dd></div>
          <div><dt>Initiated at</dt><dd>{formatAdminDate(payout.initiatedAt)}</dd></div>
          <div><dt>Payment method</dt><dd>{fieldValue(payout.method)}</dd></div>
          <div><dt>Transfer reference</dt><dd>{fieldValue(payout.transferReference)}</dd></div>
          <div><dt>Paid on</dt><dd>{fieldValue(payout.paidOn)}</dd></div>
          <div><dt>Paid by</dt><dd>{fieldValue(payout.paidBy)}</dd></div>
          <div><dt>Paid at</dt><dd>{formatAdminDate(payout.paidAt)}</dd></div>
          <div><dt>Approved by</dt><dd>{fieldValue(payout.approvedBy)}</dd></div>
          <div><dt>Approved at</dt><dd>{formatAdminDate(payout.approvedAt)}</dd></div>
          <div><dt>Failure reason</dt><dd>{fieldValue(payout.failureReason)}</dd></div>
          <div><dt>Failed by</dt><dd>{fieldValue(payout.failedBy)}</dd></div>
          <div><dt>Failed at</dt><dd>{formatAdminDate(payout.failedAt)}</dd></div>
          <div><dt>Requires approval</dt><dd>{payout.requiresApproval ? 'Yes' : 'No'}</dd></div>
        </dl>
      </article>

      {approvalAllowed && (
        <form className="admin-card admin-form admin-payout-action" onSubmit={(event) => {
          event.preventDefault()
          performAction({
            name: 'approve',
            action: 'payout.approve',
            successMessage: 'Payout approved.',
            request: (stepUpGrant) => api.approveAdminSellerPayout(payoutId, { stepUpGrant }),
          })
        }}>
          <h2>Approve payout</h2>
          <p>A different Admin must approve this payout.</p>
          <label>Authenticator code
            <input
              value={codes.approve}
              onChange={(event) => setCodes((current) => ({ ...current, approve: event.target.value }))}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
            />
          </label>
          <button className="admin-button admin-button-primary" type="submit" disabled={Boolean(pending)}>
            {pending === 'approve' ? 'Approving…' : 'Approve payout'}
          </button>
        </form>
      )}

      {paymentAllowed && (
        <form className="admin-card admin-form admin-payout-action" onSubmit={submitPaid}>
          <h2>Record manual payment</h2>
          <label>Method
            <select value={paidForm.method} onChange={(event) => updatePaidForm('method', event.target.value)}>
              <option value="bank">Bank</option>
              <option value="easypaisa">Easypaisa</option>
              <option value="jazzcash">JazzCash</option>
            </select>
          </label>
          <label>Transfer reference (6–100 characters)
            <input
              value={paidForm.transferReference}
              onChange={(event) => updatePaidForm('transferReference', event.target.value)}
              minLength={6}
              maxLength={100}
              required
            />
          </label>
          <label>Paid on
            <input
              type="date"
              value={paidForm.paidOn}
              max={localToday()}
              onChange={(event) => updatePaidForm('paidOn', event.target.value)}
              required
            />
          </label>
          <label>Admin note (optional)
            <textarea
              value={paidForm.note}
              onChange={(event) => updatePaidForm('note', event.target.value)}
              maxLength={300}
            />
          </label>
          <label>Authenticator code
            <input
              value={codes.paid}
              onChange={(event) => setCodes((current) => ({ ...current, paid: event.target.value }))}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
            />
          </label>
          <button className="admin-button admin-button-primary" type="submit" disabled={Boolean(pending)}>
            {pending === 'paid' ? 'Saving…' : 'Mark paid'}
          </button>
        </form>
      )}

      {failureAllowed && (
        <form className="admin-card admin-form admin-payout-action" onSubmit={submitFailed}>
          <h2>Record failed transfer</h2>
          <label>Failure reason (3–300 characters)
            <textarea
              value={failureReason}
              onChange={(event) => setFailureReason(event.target.value)}
              minLength={3}
              maxLength={300}
              required
            />
          </label>
          <label>Authenticator code
            <input
              value={codes.failed}
              onChange={(event) => setCodes((current) => ({ ...current, failed: event.target.value }))}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
            />
          </label>
          <button className="admin-button" type="submit" disabled={Boolean(pending)}>
            {pending === 'failed' ? 'Saving…' : 'Mark failed'}
          </button>
        </form>
      )}

      {retryAllowed && (
        <form className="admin-card admin-form admin-payout-action" onSubmit={(event) => {
          event.preventDefault()
          performAction({
            name: 'retry',
            action: 'payout.record',
            successMessage: 'A new payout attempt was created.',
            request: (stepUpGrant) => api.retryAdminSellerPayout(payoutId, { stepUpGrant }),
          })
        }}>
          <h2>Retry payout</h2>
          <p>A new payout attempt requires a fresh authenticator check and approval when applicable.</p>
          <label>Authenticator code
            <input
              value={codes.retry}
              onChange={(event) => setCodes((current) => ({ ...current, retry: event.target.value }))}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
            />
          </label>
          <button className="admin-button admin-button-primary" type="submit" disabled={Boolean(pending)}>
            {pending === 'retry' ? 'Retrying…' : 'Create retry attempt'}
          </button>
        </form>
      )}
    </section>
  )
}
