import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import { adminErrorMessage, formatAdminDate } from './lib/admin.js'
import { formatPkr, validateHeldDecision } from './lib/payouts.js'

function reminderCount(heldFunds) {
  return [
    heldFunds.reminder_7_sent_at,
    heldFunds.reminder_30_sent_at,
    heldFunds.reminder_90_sent_at,
  ].filter(Boolean).length
}

function fieldValue(value) {
  return value === null || value === undefined || value === '' ? '—' : value
}

export default function AdminHeldFunds() {
  const [heldFunds, setHeldFunds] = useState([])
  const [state, setState] = useState('')
  const [needsDecision, setNeedsDecision] = useState('')
  const [notes, setNotes] = useState({})
  const [codes, setCodes] = useState({})
  const [loading, setLoading] = useState(true)
  const [pendingId, setPendingId] = useState('')
  const [error, setError] = useState('')
  const [listError, setListError] = useState('')
  const [notice, setNotice] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    api.getAdminHeldFunds({ state, needsDecision, limit: 100 }).then((result) => {
      if (active) setHeldFunds(result.heldFunds || [])
    }).catch((cause) => {
      if (active) setListError(adminErrorMessage(cause))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [state, needsDecision, reload])

  async function decide(held, decision) {
    const note = notes[held.id] || ''
    const code = codes[held.id] || ''
    const validation = validateHeldDecision({ decision, note })
    if (validation) {
      setError(validation)
      return
    }
    if (!code.trim()) {
      setError('Enter your authenticator code to decide held funds.')
      return
    }

    setPendingId(held.id)
    setError('')
    setNotice('')
    try {
      const stepUp = await api.createStepUpGrant('payout.record', code)
      const input = {
        decision,
        ...(decision === 'keep_held' ? { note: note.trim() } : {}),
        stepUpGrant: stepUp.grant,
      }
      await api.decideAdminHeldFunds(held.id, input)
      setNotice(decision === 'release'
        ? 'Held funds released and a payout initiated.'
        : 'Funds remain held; the decision note was recorded.')
      setLoading(true)
      setReload((current) => current + 1)
    } catch (cause) {
      setError(adminErrorMessage(cause))
    } finally {
      setCodes((current) => ({ ...current, [held.id]: '' }))
      setPendingId('')
    }
  }

  function changeState(value) {
    setLoading(true)
    setState(value)
    setListError('')
  }

  function changeNeedsDecision(value) {
    setLoading(true)
    setNeedsDecision(value)
    setListError('')
  }

  return (
    <section>
      <div className="admin-toolbar">
        <div><p className="admin-eyebrow">Payments</p><h1>Held funds</h1></div>
        <div className="admin-filter">
          <label>State
            <select value={state} onChange={(event) => { changeState(event.target.value); setError('') }}>
              <option value="">All states</option>
              <option value="held">Held</option>
              <option value="released">Released</option>
            </select>
          </label>
          <label>Decision
            <select value={needsDecision} onChange={(event) => { changeNeedsDecision(event.target.value); setError('') }}>
              <option value="">Any</option>
              <option value="true">Needs decision</option>
            </select>
          </label>
        </div>
      </div>
      {listError && <p className="admin-error" role="alert">{listError}</p>}
      {error && <p className="admin-error" role="alert">{error}</p>}
      {notice && <p className="admin-notice" role="status">{notice}</p>}
      {loading ? <p role="status">Loading held funds…</p> : listError ? null : heldFunds.length === 0
        ? <p role="status">No held-funds records found.</p>
        : <div className="admin-list">
          {heldFunds.map((held) => (
            <article className="admin-card admin-row" key={held.id}>
              <h2>Held funds record</h2>
              <dl className="admin-data-grid">
                <div><dt>Order</dt><dd><a href={`/admin/orders/${encodeURIComponent(held.order_id)}`}>{held.order_id}</a></dd></div>
                <div><dt>Seller ID</dt><dd>{held.seller_id}</dd></div>
                <div><dt>Amount</dt><dd>{formatPkr(held.amount)}</dd></div>
                <div><dt>State</dt><dd>{fieldValue(held.state)}</dd></div>
                <div><dt>Held at</dt><dd>{formatAdminDate(held.held_at)}</dd></div>
                <div><dt>Reminders sent</dt><dd>{reminderCount(held)} of 3</dd></div>
                <div><dt>Needs decision at</dt><dd>{formatAdminDate(held.needs_decision_at)}</dd></div>
                <div><dt>Last decision note</dt><dd>{fieldValue(held.last_decision_note)}</dd></div>
                <div><dt>Last decision by</dt><dd>{fieldValue(held.last_decision_by)}</dd></div>
                <div><dt>Last decision at</dt><dd>{formatAdminDate(held.last_decision_at)}</dd></div>
                <div><dt>Released payout</dt><dd>{fieldValue(held.released_payout_id)}</dd></div>
              </dl>
              {held.state === 'held' && (
                <div className="admin-form admin-held-decision">
                  <label>Decision note (required to keep funds held; 3–300 characters)
                    <textarea
                      value={notes[held.id] || ''}
                      onChange={(event) => setNotes((current) => ({ ...current, [held.id]: event.target.value }))}
                      minLength={3}
                      maxLength={300}
                    />
                  </label>
                  <label>Authenticator code
                    <input
                      value={codes[held.id] || ''}
                      onChange={(event) => setCodes((current) => ({ ...current, [held.id]: event.target.value }))}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="[0-9]{6}"
                      maxLength={6}
                    />
                  </label>
                  <div className="admin-filter">
                    <button className="admin-button" type="button" onClick={() => decide(held, 'keep_held')} disabled={Boolean(pendingId)}>
                      {pendingId === held.id ? 'Saving…' : 'Keep held'}
                    </button>
                    <button className="admin-button admin-button-primary" type="button" onClick={() => decide(held, 'release')} disabled={Boolean(pendingId)}>
                      {pendingId === held.id ? 'Saving…' : 'Release'}
                    </button>
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>}
      {!loading && listError && (
        <div className="admin-pagination">
          <button className="admin-button" type="button" onClick={() => {
            setLoading(true)
            setListError('')
            setReload((current) => current + 1)
          }}>Retry held-funds list</button>
        </div>
      )}
    </section>
  )
}
