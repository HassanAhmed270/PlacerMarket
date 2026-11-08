import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import { adminErrorMessage, adminStatusLabel, formatAdminDate, validateExceptionResolutionNote } from './lib/admin.js'

const EXCEPTION_KINDS = [
  'late_handover_after_auto_cancel',
  'handover_after_cancel',
  'dispute_refund_required',
]

export default function AdminExceptions() {
  const [status, setStatus] = useState('unresolved')
  const [kind, setKind] = useState('')
  const [exceptions, setExceptions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    api.getAdminExceptions({ status, kind, limit: 100 }).then((result) => {
      if (active) setExceptions(Array.isArray(result) ? result : [])
    }).catch((cause) => {
      if (active) setError(adminErrorMessage(cause))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [status, kind, reload])

  function changeStatus(value) {
    setLoading(true)
    setError('')
    setStatus(value)
  }

  function changeKind(value) {
    setLoading(true)
    setError('')
    setKind(value)
  }

  function reloadExceptions() {
    setLoading(true)
    setError('')
    setReload((value) => value + 1)
  }

  return (
    <section>
      <div className="admin-toolbar">
        <div><p className="admin-eyebrow">Delivery follow-up</p><h1>Exceptions</h1></div>
        <div className="admin-filter">
          <label>Status
            <select value={status} onChange={(event) => changeStatus(event.target.value)}>
              <option value="unresolved">Unresolved</option>
              <option value="resolved">Resolved</option>
              <option value="all">All</option>
            </select>
          </label>
          <label>Kind
            <select value={kind} onChange={(event) => changeKind(event.target.value)}>
              <option value="">All kinds</option>
              {EXCEPTION_KINDS.map((value) => <option key={value} value={value}>{adminStatusLabel(value)}</option>)}
            </select>
          </label>
        </div>
      </div>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {loading ? <p role="status">Loading exceptions…</p> : exceptions.length === 0
        ? <p role="status">No exceptions found.</p>
        : <div className="admin-list">
          {exceptions.map((exception) => (
            <ExceptionRow
              key={exception.id}
              exception={exception}
              onError={setError}
              onResolved={reloadExceptions}
            />
          ))}
        </div>}
    </section>
  )
}

function ExceptionRow({ exception, onError, onResolved }) {
  const [pending, setPending] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  async function submit(event) {
    event.preventDefault()
    const note = String(new FormData(event.currentTarget).get('resolutionNote') || '')
    const validation = validateExceptionResolutionNote(note)
    if (validation) {
      onError(validation)
      return
    }
    if (!confirmed) {
      onError('Confirm that the exception resolution is accurate.')
      return
    }
    setPending(true)
    onError('')
    try {
      await api.resolveAdminException(exception.id, note.trim())
      onResolved()
    } catch (cause) {
      onError(adminErrorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  const unresolved = !exception.resolvedAt
  return (
    <article className="admin-card admin-row">
      <h2>{adminStatusLabel(exception.kind)}</h2>
      <p><a href={`/admin/orders/${encodeURIComponent(exception.orderId)}`}>Open order</a> · Recorded {formatAdminDate(exception.recordedAt)}</p>
      <p><strong>Courier pickup:</strong> {formatAdminDate(exception.courierPickupAt)} · <strong>Status:</strong> {unresolved ? 'Unresolved' : 'Resolved'}</p>
      {exception.note && <p><strong>Original note:</strong> {exception.note}</p>}
      {!unresolved && <p><strong>Resolution:</strong> {exception.resolutionNote || '—'} · {formatAdminDate(exception.resolvedAt)}</p>}
      {unresolved && exception.kind === 'dispute_refund_required' && (
        <p>
          Resolving the dispute moved no money. Request a refund; this closes automatically when the refund succeeds.{' '}
          <a href={`/admin/refunds/request?orderId=${encodeURIComponent(exception.orderId)}`}>Request a refund</a>
        </p>
      )}
      {unresolved && exception.kind !== 'dispute_refund_required' && (
        <form className="admin-form admin-inline-confirm" onSubmit={submit}>
          <label>Resolution note<textarea name="resolutionNote" required minLength="3" maxLength="500" /></label>
          <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I confirm this exception is resolved.</label>
          <button className="admin-button admin-button-primary" type="submit" disabled={pending || !confirmed}>
            {pending ? 'Resolving…' : 'Resolve exception'}
          </button>
        </form>
      )}
    </article>
  )
}
