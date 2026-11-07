import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import { adminErrorMessage, adminStatusLabel, formatAdminDate, validateDisputeResolution } from './lib/admin.js'

const DISPUTE_STATUSES = ['open', 'seller_responded', 'resolved_refund', 'resolved_release']

export default function AdminDisputes() {
  const [status, setStatus] = useState('')
  const [disputes, setDisputes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    api.getAdminDisputes({ status }).then((result) => {
      if (active) setDisputes(Array.isArray(result) ? result : [])
    }).catch((cause) => {
      if (active) setError(adminErrorMessage(cause))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [status, reload])

  function changeStatus(value) {
    setLoading(true)
    setError('')
    setStatus(value)
  }

  function reloadDisputes() {
    setLoading(true)
    setError('')
    setReload((value) => value + 1)
  }

  return (
    <section>
      <div className="admin-toolbar">
        <div><p className="admin-eyebrow">Case review</p><h1>Disputes</h1></div>
        <div className="admin-filter">
          <label>Status
            <select value={status} onChange={(event) => changeStatus(event.target.value)}>
              <option value="">All statuses</option>
              {DISPUTE_STATUSES.map((value) => <option key={value} value={value}>{adminStatusLabel(value)}</option>)}
            </select>
          </label>
        </div>
      </div>
      <p>Evidence links are shown as text and are not opened automatically.</p>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {loading ? <p role="status">Loading disputes…</p> : disputes.length === 0
        ? <p role="status">No disputes found.</p>
        : <div className="admin-list">
          {disputes.map((dispute) => (
            <DisputeRow
              key={dispute.id}
              dispute={dispute}
              onError={setError}
              onResolved={reloadDisputes}
            />
          ))}
        </div>}
    </section>
  )
}

function DisputeRow({ dispute, onError, onResolved }) {
  const [evidence, setEvidence] = useState(null)
  const [evidenceLoading, setEvidenceLoading] = useState(false)
  const [pending, setPending] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const unresolved = ['open', 'seller_responded'].includes(dispute.status)
  const orderId = dispute.order_id || dispute.orderId

  async function toggleEvidence() {
    if (evidence) {
      setEvidence(null)
      return
    }
    setEvidenceLoading(true)
    onError('')
    try {
      const result = await api.getAdminDisputeEvidence(dispute.id)
      setEvidence(Array.isArray(result) ? result : [])
    } catch (cause) {
      onError(adminErrorMessage(cause))
    } finally {
      setEvidenceLoading(false)
    }
  }

  async function submit(event) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const input = {
      amount: String(form.get('resolutionAmountToBuyer') || ''),
      note: String(form.get('resolutionNote') || ''),
    }
    const validation = validateDisputeResolution(input)
    if (validation) {
      onError(validation)
      return
    }
    if (!confirmed) {
      onError('Confirm that the dispute resolution is accurate.')
      return
    }
    setPending(true)
    onError('')
    try {
      await api.resolveAdminDispute(dispute.id, {
        resolutionAmountToBuyer: input.amount.trim(),
        ...(input.note.trim() ? { resolutionNote: input.note.trim() } : {}),
      })
      onResolved()
    } catch (cause) {
      onError(adminErrorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <article className="admin-card admin-row">
      <h2>{adminStatusLabel(dispute.status)}</h2>
      <p><a href={`/admin/orders/${encodeURIComponent(orderId || '')}`}>Open order</a> · Filed {formatAdminDate(dispute.created_at || dispute.createdAt)}</p>
      {dispute.reason_text && <p><strong>Reason:</strong> {dispute.reason_text}</p>}
      <button className="admin-button" type="button" onClick={toggleEvidence} disabled={evidenceLoading}>
        {evidenceLoading ? 'Loading evidence…' : evidence ? 'Hide evidence' : 'View evidence'}
      </button>
      {evidence && (evidence.length
        ? <ul>
          {evidence.map((item) => (
            <li key={item.id}>
              {item.file_url || item.fileUrl || 'Evidence item'} · {formatAdminDate(item.created_at || item.createdAt)}
            </li>
          ))}
        </ul>
        : <p role="status">No evidence attached.</p>)}
      {unresolved ? (
        <form className="admin-form admin-inline-confirm" onSubmit={submit}>
          <p>This records the decision only and moves no money. Resolving for the seller lets an Admin release the manual payout from the order page. Resolving for the buyer creates a &quot;refund required&quot; exception that must be handled manually under Exceptions.</p>
          <label>Resolution amount to buyer
            <input name="resolutionAmountToBuyer" inputMode="decimal" required placeholder="0 or full item price" />
          </label>
          <label>Resolution note (optional)<textarea name="resolutionNote" maxLength="500" /></label>
          <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I confirm this resolution is accurate.</label>
          <button className="admin-button admin-button-primary" type="submit" disabled={pending || !confirmed}>
            {pending ? 'Resolving…' : 'Resolve dispute'}
          </button>
        </form>
      ) : <p>Dispute resolved. No further resolution action is available.</p>}
    </article>
  )
}
