import { useCallback, useEffect, useState } from 'react'
import { api, DEV_FAKES_BANNER } from './lib/api.js'

function AccountWorkspace({ onSignOut }) {
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [application, setApplication] = useState(null)
  const [profile, setProfile] = useState(null)
  const [payout, setPayout] = useState(null)
  const [setup, setSetup] = useState(null)
  const [backupCodes, setBackupCodes] = useState([])
  const [grant, setGrant] = useState('')
  const [applications, setApplications] = useState([])
  const [payouts, setPayouts] = useState([])
  const [busy, setBusy] = useState(false)

  const refreshSeller = useCallback(async () => {
    const results = await Promise.allSettled([api.getSellerApplication(), api.getSellerProfile(), api.getPayout()])
    if (results[0].status === 'fulfilled') setApplication(results[0].value)
    if (results[1].status === 'fulfilled') setProfile(results[1].value)
    if (results[2].status === 'fulfilled') setPayout(results[2].value)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(refreshSeller, 0)
    return () => window.clearTimeout(timer)
  }, [refreshSeller])

  async function perform(action) {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await action()
    } catch (cause) {
      setError(cause.payload?.error || cause.message || 'The request could not be completed.')
    } finally { setBusy(false) }
  }

  async function loadAdminData() {
    await perform(async () => {
      const [nextApplications, nextPayouts] = await Promise.all([api.getAdminApplications(), api.getAdminPayouts()])
      setApplications(nextApplications)
      setPayouts(nextPayouts)
      setMessage('Admin queues refreshed.')
    })
  }

  async function requestGrant(event) {
    event.preventDefault()
    const code = new FormData(event.currentTarget).get('stepUpCode')
    await perform(async () => {
      const result = await api.createStepUpGrant('payout.update', code)
      setGrant(result.grant)
      setMessage(`Payout update approved for ${Math.floor(result.expiresIn / 60)} minutes. Submit your details before it expires.`)
    })
  }

  async function savePayout(event) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const method = form.get('method')
    const input = method === 'bank'
      ? { method, bankName: form.get('bankName'), accountTitle: form.get('accountTitle'), iban: form.get('iban'), stepUpGrant: grant }
      : { method, walletNumber: form.get('walletNumber'), accountHolderName: form.get('accountHolderName'), stepUpGrant: grant }
    await perform(async () => {
      const result = await api.updatePayout(input)
      setPayout(result)
      setGrant('')
      setMessage(`Payout details saved. Only the last four digits (${result.last4}) are shown.`)
      await refreshSeller()
    })
  }

  return (
    <main className="account-shell">
      <header className="account-header">
        <a className="wordmark" href="/">Poshaak</a>
        <button className="text-button" type="button" onClick={onSignOut}>Close workspace</button>
      </header>
      <div className="account-title">
        <div><p className="eyebrow">Secure account workspace</p><h1>Seller &amp; admin tools</h1></div>
        <span className="section-index">Phase 1 preview</span>
      </div>
      {DEV_FAKES_BANNER && <p className="auth-mock-banner" role="status">Development only: DEV_FAKES is enabled. Provider actions may be simulated.</p>}
      {message && <p className="auth-notice" role="status">{message}</p>}
      {error && <p className="auth-error" role="alert">{error}</p>}

      <section className="workspace-card" aria-labelledby="application-title">
        <p className="eyebrow">Seller onboarding</p><h2 id="application-title">Seller application</h2>
        {application ? <p>Current status: <strong>{application.status}</strong>{application.rejection_reason ? ` — ${application.rejection_reason}` : ''}</p> : <p>Submit your reason for selling and what you plan to offer. Your profile supplies your name, phone, and verified city.</p>}
        {(!application || application.status === 'rejected') && <form onSubmit={(event) => {
          event.preventDefault()
          const form = new FormData(event.currentTarget)
          perform(async () => { setApplication(await api.submitSellerApplication({ reasonForSelling: form.get('reasonForSelling'), whatWillSell: form.get('whatWillSell') })); setMessage('Seller application submitted.') })
        }}>
          <label>Why do you want to sell?<textarea name="reasonForSelling" required minLength="2" maxLength="2000" /></label>
          <label>What will you sell?<textarea name="whatWillSell" required minLength="2" maxLength="2000" /></label>
          <button className="button button-primary" disabled={busy}>Submit application</button>
        </form>}
        {profile && <p className="account-meta">Seller profile · {profile.is_approved ? 'Approved' : 'Not approved'} · Identity {profile.id_verified ? 'verified' : 'not yet verified'}</p>}
      </section>

      <section className="workspace-card" aria-labelledby="authenticator-title">
        <p className="eyebrow">Account security</p><h2 id="authenticator-title">Authenticator setup</h2>
        {!setup && backupCodes.length === 0 && <button className="button button-secondary" disabled={busy} onClick={() => perform(async () => { setSetup(await api.beginAuthenticatorEnrollment()); setMessage('Add this secret to your authenticator app, then confirm a current code.') })}>Start authenticator setup</button>}
        {setup && <div className="secret-panel"><p>Enter this secret into your authenticator app. QR setup is planned for a later phase.</p><code>{setup.secret}</code><p className="break-anywhere">{setup.otpauthUri}</p>
          <form onSubmit={(event) => { event.preventDefault(); const code = new FormData(event.currentTarget).get('enrollmentCode'); perform(async () => { const result = await api.confirmAuthenticatorEnrollment(code); setBackupCodes(result.backupCodes); setSetup(null); setMessage('Authenticator enabled. Save your recovery codes now; they are shown only once.') }) }}>
            <label>Current six-digit code<input name="enrollmentCode" inputMode="numeric" pattern="\d{6}" required /></label><button className="button button-primary" disabled={busy}>Confirm authenticator</button>
          </form>
        </div>}
        {backupCodes.length > 0 && <div className="backup-codes"><p>Store these ten single-use recovery codes securely. They will disappear when you leave this page.</p><ul>{backupCodes.map((code) => <li key={code}><code>{code}</code></li>)}</ul><button className="text-button" onClick={() => setBackupCodes([])}>I saved these codes</button></div>}
      </section>

      <section className="workspace-card" aria-labelledby="payout-title">
        <p className="eyebrow">Seller payout</p><h2 id="payout-title">Payout details</h2>
        <p>{payout?.configured ? `${payout.method} ending in ${payout.last4}` : payout?.needsUpdate ? 'Existing payout details need updating.' : 'No payout details saved.'}</p>
        <form className="compact-form" onSubmit={requestGrant}>
          <label>Authenticator code for payout change<input name="stepUpCode" autoComplete="one-time-code" inputMode="numeric" pattern="\d{6}" required /></label>
          <button className="button button-secondary" disabled={busy}>Verify &amp; authorize change</button>
        </form>
        <form onSubmit={savePayout}>
          <label>Method<select name="method"><option value="bank">Bank account</option><option value="easypaisa">Easypaisa</option><option value="jazzcash">JazzCash</option></select></label>
          <p className="form-hint">Bank: enter bank name, account title, and Pakistani IBAN. Wallet methods: enter the account holder and Pakistan mobile number.</p>
          <label>Bank name<input name="bankName" maxLength="120" /></label>
          <label>Account title<input name="accountTitle" maxLength="120" /></label>
          <label>Pakistani IBAN<input name="iban" autoComplete="off" maxLength="34" /></label>
          <label>Wallet number<input name="walletNumber" autoComplete="off" maxLength="16" /></label>
          <label>Wallet account-holder name<input name="accountHolderName" maxLength="120" /></label>
          <button className="button button-primary" disabled={busy || !grant}>Save payout details</button>
          {!grant && <p className="form-hint">Verify your authenticator above to enable saving.</p>}
        </form>
      </section>

      <section className="workspace-card admin-workspace" aria-labelledby="admin-title">
        <p className="eyebrow">Admin console</p><h2 id="admin-title">Seller review &amp; payout controls</h2>
        <button className="button button-secondary" disabled={busy} onClick={loadAdminData}>Load admin queues</button>
        {applications.map((item) => <AdminApplication key={item.id} item={item} busy={busy} act={perform} onDone={loadAdminData} />)}
        {payouts.map((item) => <AdminPayout key={item.sellerId} item={item} busy={busy} act={perform} onDone={loadAdminData} />)}
      </section>
    </main>
  )
}

function AdminApplication({ item, busy, act, onDone }) {
  const [note, setNote] = useState('')
  return <article className="admin-row"><h3>Application {item.id}</h3><p>{item.full_name} · {item.city_name || 'No verified city'} · {item.phone}</p><p>{item.reason_for_selling}</p><p>{item.what_will_sell}</p><form onSubmit={(event) => { event.preventDefault(); const decision = event.nativeEvent.submitter?.value; act(async () => { await api.reviewSellerApplication(item.id, decision, decision === 'rejected' ? note : undefined); setNote(''); await onDone() }) }}>
    <label>Review note<input value={note} onChange={(event) => setNote(event.target.value)} maxLength="500" /></label>
    <div className="button-row"><button name="decision" value="approved" className="button button-primary" disabled={busy}>Approve</button><button name="decision" value="rejected" className="button button-secondary" disabled={busy}>Reject</button></div>
  </form></article>
}

function AdminPayout({ item, busy, act, onDone }) {
  const [note, setNote] = useState('')
  return <article className="admin-row"><h3>{item.displayAlias || item.sellerId}</h3>
    <p>{item.method || 'No method'} · ending {item.last4 || '—'} · changed recently: {item.changedRecently ? 'Yes' : 'No'} · ID verified: {item.idVerified ? 'Yes' : 'No'} · hold: {item.payoutHoldActive ? item.payoutHoldReason : 'none'}</p>
    <form onSubmit={(event) => { event.preventDefault(); act(async () => { await api.verifySellerIdentity(item.sellerId, note); setNote(''); await onDone() }) }}>
      <label>Manual identity check note<input value={note} onChange={(event) => setNote(event.target.value)} required maxLength="500" /></label>
      <button className="button button-secondary" disabled={busy}>Mark identity verified</button>
    </form>
    <form onSubmit={(event) => { event.preventDefault(); act(async () => { if (item.payoutHoldActive) await api.clearPayoutHold(item.sellerId, note); else await api.setPayoutHold(item.sellerId, note); setNote(''); await onDone() }) }}>
      <label>Hold reason / resolution note<input value={note} onChange={(event) => setNote(event.target.value)} required maxLength="500" /></label>
      <button className="button button-secondary" disabled={busy}>{item.payoutHoldActive ? 'Clear payout hold' : 'Place payout hold'}</button>
    </form>
  </article>
}

export default AccountWorkspace
