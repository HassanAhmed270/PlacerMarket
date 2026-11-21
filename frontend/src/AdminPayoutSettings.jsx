import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import { adminErrorMessage } from './lib/admin.js'
import { formatPkr, validateCommissionPercent } from './lib/payouts.js'

export default function AdminPayoutSettings() {
  const [settings, setSettings] = useState(null)
  const [commissionPercent, setCommissionPercent] = useState('')
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [stepUpCode, setStepUpCode] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    api.getAdminPayoutSettings().then((result) => {
      if (!active) return
      setSettings(result)
      setCommissionPercent(result.commissionPercent === null || result.commissionPercent === undefined
        ? ''
        : String(result.commissionPercent))
    }).catch((cause) => {
      if (active) setError(adminErrorMessage(cause))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [reload])

  async function saveCommission(event) {
    event.preventDefault()
    const validation = validateCommissionPercent(commissionPercent)
    if (validation) {
      setError(validation)
      return
    }
    if (!window.confirm('Applies to new orders only; existing orders keep their rate. Continue?')) return
    if (!stepUpCode.trim()) {
      setError('Enter your authenticator code to continue.')
      return
    }

    setPending(true)
    setError('')
    setNotice('')
    try {
      const stepUp = await api.createStepUpGrant('commission.update', stepUpCode.trim())
      await api.updateAdminCommission(commissionPercent.trim(), stepUp.grant)
      setNotice('Commission updated. It applies to new orders only.')
      setLoading(true)
      setReload((current) => current + 1)
    } catch (cause) {
      setError(adminErrorMessage(cause))
    } finally {
      setStepUpCode('')
      setPending(false)
    }
  }

  return (
    <section>
      <p className="admin-eyebrow">Payments</p>
      <h1>Payout settings</h1>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {notice && <p className="admin-notice" role="status">{notice}</p>}
      {loading ? <p role="status">Loading payout settings…</p> : settings && (
        <>
          <section className="admin-card admin-payout-settings" aria-labelledby="commission-title">
            <h2 id="commission-title">Commission</h2>
            <p>Changes apply to new orders only; existing orders keep their snapshotted rate.</p>
            <form className="admin-form" onSubmit={saveCommission}>
              <label>Commission percentage (0–100; up to 2 decimal places)
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={commissionPercent}
                  onChange={(event) => setCommissionPercent(event.target.value)}
                  maxLength={8}
                  required
                />
              </label>
              <label>Authenticator code
                <input
                  name="commission-step-up-code"
                  value={stepUpCode}
                  onChange={(event) => setStepUpCode(event.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                />
              </label>
              <button className="admin-button admin-button-primary" type="submit" disabled={pending}>
                {pending ? 'Saving…' : 'Save commission'}
              </button>
            </form>
          </section>
          <section className="admin-card admin-payout-settings" aria-labelledby="approval-threshold-title">
            <h2 id="approval-threshold-title">Two-Admin approval threshold</h2>
            <p>Approval is required for a payout strictly above this threshold.</p>
            <p><strong>{settings.payoutTwoAdminThreshold === null || settings.payoutTwoAdminThreshold === undefined
              ? 'Not configured'
              : formatPkr(String(settings.payoutTwoAdminThreshold))}</strong></p>
            <p>Currency: {settings.currency || 'PKR'}</p>
          </section>
        </>
      )}
      {!loading && !settings && error && (
        <button className="admin-button" type="button" onClick={() => {
          setLoading(true)
          setError('')
          setReload((current) => current + 1)
        }}>Retry</button>
      )}
    </section>
  )
}
