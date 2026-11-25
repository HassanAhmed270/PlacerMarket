import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import {
  adminErrorMessage,
  chargebackStatusLabel,
  formatAdminAmount,
  formatAdminDate,
  validateChargebackResolveForm,
} from './lib/admin.js'

const CHARGEBACK_STATUSES = ['open', 'won', 'lost']

export default function AdminChargebacks({ chargebackId = '' }) {
  return chargebackId ? <AdminChargebackDetail chargebackId={chargebackId} /> : <AdminChargebackList />
}

function AdminChargebackList() {
  const [status, setStatus] = useState('')
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    api.getAdminChargebacks({ status, limit: 100 }).then((result) => {
      if (active) setItems(result.chargebacks || [])
    }).catch((cause) => {
      if (active) setError(adminErrorMessage(cause))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [status])

  function changeStatus(value) {
    setLoading(true)
    setError('')
    setStatus(value)
  }

  return (
    <section>
      <div className="admin-toolbar">
        <div><p className="admin-eyebrow">Refund operations</p><h1>Chargebacks</h1></div>
        <div className="admin-filter">
          <label>Status
            <select value={status} onChange={(event) => changeStatus(event.target.value)}>
              <option value="">All statuses</option>
              {CHARGEBACK_STATUSES.map((value) => <option key={value} value={value}>{chargebackStatusLabel(value)}</option>)}
            </select>
          </label>
        </div>
      </div>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {loading ? <p role="status">Loading chargebacks…</p> : items.length === 0
        ? <p role="status">No chargebacks found.</p>
        : <div className="admin-list">
          {items.map((item) => (
            <article className="admin-card admin-row" key={item.chargebackId}>
              <h2><a href={`/admin/chargebacks/${encodeURIComponent(item.chargebackId)}`}>{item.reference}</a></h2>
              <p><strong>Status:</strong> {chargebackStatusLabel(item.status)} · <strong>Amount:</strong> {formatAdminAmount(item.amount, item.currency)}</p>
              <p><strong>Recorded:</strong> {formatAdminDate(item.createdAt)}</p>
              <p><a href={`/admin/orders/${encodeURIComponent(item.orderId)}`}>Open order</a></p>
            </article>
          ))}
        </div>}
    </section>
  )
}

function AdminChargebackDetail({ chargebackId }) {
  const [item, setItem] = useState(null)
  const [outcome, setOutcome] = useState('')
  const [resolutionNote, setResolutionNote] = useState('')
  const [authenticatorCode, setAuthenticatorCode] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    api.getAdminChargeback(chargebackId).then((result) => {
      if (active) setItem(result)
    }).catch((cause) => {
      if (active) setError(adminErrorMessage(cause))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [chargebackId, reload])

  async function submit(event) {
    event.preventDefault()
    const validation = validateChargebackResolveForm({ outcome, resolutionNote })
    if (validation) {
      setError(validation)
      return
    }
    if (!authenticatorCode.trim()) {
      setError('Enter your authenticator code.')
      return
    }
    if (!confirmed) {
      setError('Confirm the chargeback resolution before submitting.')
      return
    }
    setPending(true)
    setError('')
    setNotice('')
    try {
      const stepUp = await api.createStepUpGrant('refund.decide', authenticatorCode.trim())
      await api.resolveAdminChargeback(chargebackId, {
        outcome,
        resolutionNote: resolutionNote.trim(),
        stepUpGrant: stepUp.grant,
      })
      setAuthenticatorCode('')
      setConfirmed(false)
      setNotice('Chargeback resolution recorded. The detail was refreshed.')
      setLoading(true)
      setReload((value) => value + 1)
    } catch (cause) {
      setError(adminErrorMessage(cause))
    } finally {
      setPending(false)
      setAuthenticatorCode('')
    }
  }

  if (loading && !item) return <p role="status">Loading chargeback…</p>
  if (!item) return error ? <p className="admin-error" role="alert">{error}</p> : null

  return (
    <section>
      <p><a href="/admin/chargebacks">← Chargebacks</a></p>
      <h1>Chargeback</h1>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {notice && <p className="admin-notice" role="status">{notice}</p>}
      <section className="admin-card">
        <dl className="admin-data-grid">
          <div><dt>Reference</dt><dd>{item.reference}</dd></div>
          <div><dt>Status</dt><dd>{chargebackStatusLabel(item.status)}</dd></div>
          <div><dt>Amount</dt><dd>{formatAdminAmount(item.amount, item.currency)}</dd></div>
          <div><dt>Recorded</dt><dd>{formatAdminDate(item.createdAt)}</dd></div>
          <div><dt>Resolved</dt><dd>{formatAdminDate(item.resolvedAt)}</dd></div>
        </dl>
        <p><strong>Note:</strong> {item.note}</p>
        {item.resolutionNote && <p><strong>Resolution note:</strong> {item.resolutionNote}</p>}
        <p><a href={`/admin/orders/${encodeURIComponent(item.orderId)}`}>Open order</a></p>
      </section>
      {item.status === 'open' ? (
        <section className="admin-card">
          <h2>Resolve chargeback</h2>
          <form className="admin-form" onSubmit={submit}>
            <label>Outcome
              <select value={outcome} onChange={(event) => setOutcome(event.target.value)} required>
                <option value="">Choose an outcome</option>
                <option value="won">Won</option>
                <option value="lost">Lost</option>
              </select>
            </label>
            <label>Resolution note<textarea value={resolutionNote} onChange={(event) => setResolutionNote(event.target.value)} required minLength="3" maxLength="300" /></label>
            <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I confirm this chargeback resolution.</label>
            <label>Authenticator code
              <input value={authenticatorCode} onChange={(event) => setAuthenticatorCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" required />
            </label>
            <button className="admin-button admin-button-primary" type="submit" disabled={pending || !confirmed}>
              {pending ? 'Submitting…' : 'Resolve chargeback'}
            </button>
          </form>
        </section>
      ) : <p className="admin-notice">This chargeback has already been resolved.</p>}
    </section>
  )
}
