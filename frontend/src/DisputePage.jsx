import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import { getCheckoutError } from './lib/checkout.js'
import { getHttpsEvidenceHref, validateDisputeForm } from './lib/disputes.js'

function EvidenceValue({ value }) {
  const href = getHttpsEvidenceHref(value)
  return href
    ? <a href={href} target="_blank" rel="noopener noreferrer">{value}</a>
    : <span>{value}</span>
}

export default function DisputePage({ orderId }) {
  const [summary, setSummary] = useState(null)
  const [reasonText, setReasonText] = useState('')
  const [evidenceUrls, setEvidenceUrls] = useState([''])
  const [filedDispute, setFiledDispute] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState({})
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    async function loadOrder() {
      try {
        if (!api.isAuthenticated()) {
          const session = await api.refresh()
          api.setAccessToken(session.accessToken)
        }
        const order = await api.getOrderSummary(orderId)
        if (active) setSummary(order)
      } catch (cause) {
        if (!active) return
        if (cause.status === 401 || cause.status === 403) {
          const returnTo = `${window.location.pathname}${window.location.search}`
          window.location.replace(`/login?${new URLSearchParams({ returnTo })}`)
          return
        }
        setError(cause?.payload?.error || getCheckoutError(cause).message)
      } finally {
        if (active) setLoading(false)
      }
    }
    loadOrder()
    return () => { active = false }
  }, [orderId])

  function updateEvidence(index, value) {
    setEvidenceUrls((current) => current.map((item, itemIndex) => (itemIndex === index ? value : item)))
    setErrors({})
    setError('')
  }

  async function submit(event) {
    event.preventDefault()
    const limit = summary?.disputeFiling?.maxEvidenceUrls || 0
    const validation = validateDisputeForm({ reasonText, evidenceUrls, maxEvidenceUrls: limit })
    setErrors(validation.errors)
    setError('')
    if (!validation.valid) return

    setBusy(true)
    try {
      const result = await api.fileDispute(orderId, {
        reasonText: validation.reasonText,
        evidenceUrls: validation.evidenceUrls,
      })
      setFiledDispute(result)
    } catch (cause) {
      setError(cause?.payload?.error || getCheckoutError(cause).message)
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <main className="route-loading" role="status">Loading order eligibility…</main>
  if (!summary) {
    return <main className="order-page"><section className="order-panel"><h1>Order unavailable</h1><p className="checkout-error" role="alert">{error}</p></section></main>
  }

  if (!summary.disputeFiling?.canFileDispute) {
    return (
      <main className="order-page">
        <section className="order-panel">
          <h1>Problem report unavailable</h1>
          <p>This order is not currently eligible for a problem report.</p>
          <a className="button button-secondary" href={`/orders/${encodeURIComponent(orderId)}`}>Return to order</a>
        </section>
      </main>
    )
  }

  if (filedDispute) {
    return (
      <main className="order-page">
        <section className="order-panel">
          <h1>Dispute filed</h1>
          <p role="status">Status: {filedDispute.status}</p>
          <h2>Evidence URLs</h2>
          <ul>{evidenceUrls.filter(Boolean).map((value, index) => <li key={`${index}-${value}`}><EvidenceValue value={value} /></li>)}</ul>
          <a className="button button-secondary" href={`/orders/${encodeURIComponent(orderId)}`}>Return to order</a>
        </section>
      </main>
    )
  }

  const limit = summary.disputeFiling.maxEvidenceUrls
  return (
    <main className="order-page">
      <section className="order-panel">
        <p className="eyebrow">Buyer support</p>
        <h1>Report a problem</h1>
        {error && <p className="checkout-error" role="alert">{error}</p>}
        <form onSubmit={submit} noValidate>
          <label htmlFor="dispute-reason">Reason</label>
          <textarea id="dispute-reason" required value={reasonText} onChange={(event) => {
            setReasonText(event.currentTarget.value)
            setErrors({})
            setError('')
          }} />
          {errors.reasonText && <p className="field-error" role="alert">{errors.reasonText}</p>}
          <fieldset>
            <legend>Evidence URLs (HTTPS only)</legend>
            {evidenceUrls.map((value, index) => (
              <label key={index} htmlFor={`dispute-evidence-${index}`}>
                Evidence URL {index + 1}
                <input id={`dispute-evidence-${index}`} type="url" value={value} onChange={(event) => updateEvidence(index, event.currentTarget.value)} />
              </label>
            ))}
            {errors.evidenceUrls && <p className="field-error" role="alert">{errors.evidenceUrls}</p>}
            {evidenceUrls.length < limit && (
              <button className="text-button" type="button" onClick={() => setEvidenceUrls((current) => [...current, ''])}>
                Add evidence URL
              </button>
            )}
          </fieldset>
          <button className="button button-primary" type="submit" disabled={busy}>
            {busy ? 'Submitting…' : 'Submit report'}
          </button>
        </form>
        <p><a href={`/orders/${encodeURIComponent(orderId)}`}>Cancel and return to order</a></p>
      </section>
    </main>
  )
}
