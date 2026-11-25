import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import {
  adminErrorMessage,
  formatAdminDate,
  returnStatusLabel,
  validateReturnDecisionForm,
} from './lib/admin.js'

const RETURN_STATUSES = ['requested', 'seller_responded', 'approved', 'rejected']

export default function AdminReturns({ returnId = '' }) {
  return returnId ? <AdminReturnDetail returnId={returnId} /> : <AdminReturnList />
}

function AdminReturnList() {
  const [status, setStatus] = useState('')
  const [returns, setReturns] = useState([])
  const [limit, setLimit] = useState(20)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    api.getAdminReturns({ status, limit }).then((result) => {
      if (active) setReturns(result.returnRequests || [])
    }).catch((cause) => {
      if (active) setError(adminErrorMessage(cause))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [status, limit])

  function changeStatus(value) {
    setError('')
    setLimit(20)
    setLoading(true)
    setStatus(value)
  }

  async function loadMore() {
    if (loadingMore) return
    setLoadingMore(true)
    setError('')
    try {
      setLimit((current) => current + 20)
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <section>
      <div className="admin-toolbar">
        <div><p className="admin-eyebrow">Refund operations</p><h1>Returns</h1></div>
        <div className="admin-filter">
          <label>Status
            <select value={status} onChange={(event) => changeStatus(event.target.value)}>
              <option value="">All statuses</option>
              {RETURN_STATUSES.map((value) => <option key={value} value={value}>{returnStatusLabel(value)}</option>)}
            </select>
          </label>
        </div>
      </div>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {loading ? <p role="status">Loading returns…</p> : returns.length === 0
        ? <p role="status">No returns found.</p>
        : <div className="admin-list">
          {returns.map((item) => (
            <article className="admin-card admin-row" key={item.returnId}>
              <h2><a href={`/admin/returns/${encodeURIComponent(item.returnId)}`}>Return from order</a></h2>
              <p><strong>Status:</strong> {returnStatusLabel(item.status)} · <strong>Filed:</strong> {formatAdminDate(item.createdAt)}</p>
              <p>{item.reason}</p>
              {item.sellerNote && <p><strong>Seller response:</strong> {item.sellerNote}</p>}
              <p><a href={`/admin/orders/${encodeURIComponent(item.orderId)}`}>Open order</a></p>
            </article>
          ))}
        </div>}
      {returns.length >= limit && !loading && (
        <div className="admin-pagination">
          <button className="admin-button" type="button" disabled={loadingMore} onClick={loadMore}>{loadingMore ? 'Loading…' : 'Load more'}</button>
        </div>
      )}
    </section>
  )
}

function AdminReturnDetail({ returnId }) {
  const [item, setItem] = useState(null)
  const [decision, setDecision] = useState('')
  const [decisionNote, setDecisionNote] = useState('')
  const [sellerAtFault, setSellerAtFault] = useState(false)
  const [authenticatorCode, setAuthenticatorCode] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    api.getAdminReturn(returnId).then((result) => {
      if (active) setItem(result)
    }).catch((cause) => {
      if (active) setError(adminErrorMessage(cause))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [returnId, reload])

  async function submit(event) {
    event.preventDefault()
    const validation = validateReturnDecisionForm({ decision, decisionNote, sellerAtFault })
    if (validation) {
      setError(validation)
      return
    }
    if (!authenticatorCode.trim()) {
      setError('Enter your authenticator code.')
      return
    }
    if (!confirmed) {
      setError('Confirm the return decision before submitting.')
      return
    }
    setPending(true)
    setError('')
    setNotice('')
    try {
      const stepUp = await api.createStepUpGrant('refund.decide', authenticatorCode.trim())
      await api.decideAdminReturn(returnId, {
        decision,
        decisionNote: decisionNote.trim(),
        sellerAtFault: decision === 'approve_refund' ? sellerAtFault : false,
        stepUpGrant: stepUp.grant,
      })
      setNotice('Return decision recorded. The detail was refreshed.')
      setAuthenticatorCode('')
      setConfirmed(false)
      setLoading(true)
      setReload((value) => value + 1)
    } catch (cause) {
      setError(adminErrorMessage(cause))
    } finally {
      setPending(false)
      setAuthenticatorCode('')
    }
  }

  if (loading && !item) return <p role="status">Loading return…</p>
  if (!item) return error ? <p className="admin-error" role="alert">{error}</p> : null

  const canDecide = ['requested', 'seller_responded'].includes(item.status)
  return (
    <section>
      <p><a href="/admin/returns">← Returns</a></p>
      <h1>Return decision</h1>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {notice && <p className="admin-notice" role="status">{notice}</p>}
      <section className="admin-card">
        <dl className="admin-data-grid">
          <div><dt>Status</dt><dd>{returnStatusLabel(item.status)}</dd></div>
          <div><dt>Filed</dt><dd>{formatAdminDate(item.createdAt)}</dd></div>
          <div><dt>Responded</dt><dd>{formatAdminDate(item.respondedAt)}</dd></div>
          <div><dt>Decided</dt><dd>{formatAdminDate(item.decidedAt)}</dd></div>
        </dl>
        <p><strong>Buyer reason:</strong> {item.reason}</p>
        {item.sellerNote && <p><strong>Seller response:</strong> {item.sellerNote}</p>}
        {item.decisionNote && <p><strong>Decision note:</strong> {item.decisionNote}</p>}
        <p><a href={`/admin/orders/${encodeURIComponent(item.orderId)}`}>Open order</a></p>
      </section>
      {canDecide ? (
        <section className="admin-card">
          <h2>Decide return</h2>
          <p>Approve refund: the buyer is refunded and any payout not yet paid is failed. Reject: no refund or payout change is made.</p>
          <form className="admin-form" onSubmit={submit}>
            <label>Decision
              <select value={decision} onChange={(event) => setDecision(event.target.value)} required>
                <option value="">Choose a decision</option>
                <option value="approve_refund">Approve refund</option>
                <option value="reject">Reject</option>
              </select>
            </label>
            <label>Decision note<textarea value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} required minLength="3" maxLength="300" /></label>
            {decision === 'approve_refund' && (
              <label><input type="checkbox" checked={sellerAtFault} onChange={(event) => setSellerAtFault(event.target.checked)} /> Seller at fault</label>
            )}
            <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I confirm this return decision.</label>
            <label>Authenticator code
              <input value={authenticatorCode} onChange={(event) => setAuthenticatorCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" required />
            </label>
            <button className="admin-button admin-button-primary" type="submit" disabled={pending || !confirmed}>
              {pending ? 'Submitting…' : 'Submit return decision'}
            </button>
          </form>
        </section>
      ) : <p className="admin-notice">This return has already been decided.</p>}
    </section>
  )
}
