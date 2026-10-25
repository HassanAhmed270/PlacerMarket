import { lazy, Suspense, useEffect, useState } from 'react'
import { api } from './lib/api.js'

const AccountWorkspace = lazy(() => import('./AccountWorkspace.jsx'))

function AuthScreen() {
  const [path, setPath] = useState(window.location.pathname)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [challenge, setChallenge] = useState(null)
  const [challengeRequired, setChallengeRequired] = useState(false)
  const [challengeCredentials, setChallengeCredentials] = useState(null)
  const [staffFactor, setStaffFactor] = useState(false)
  const [attemptId, setAttemptId] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (path !== '/login' && path !== '/account') return undefined
    api.refresh().then((result) => {
      api.setAccessToken(result.accessToken)
      setAccessToken(result.accessToken)
    }).catch(() => {})
    return undefined
  }, [path])

  useEffect(() => {
    const onPopState = () => {
      setPath(window.location.pathname)
      setNotice('')
      setError('')
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  function navigate(next) {
    window.history.pushState({}, '', next)
    setPath(next)
    setNotice('')
    setError('')
  }

  function acceptAccessToken(token) {
    api.setAccessToken(token)
    setAccessToken(token)
    window.history.pushState({}, '', '/account')
    setPath('/account')
  }

  if (accessToken) {
    return (
      <Suspense fallback={<main className="auth-shell" role="status">Loading your account…</main>}>
        <AccountWorkspace onSignOut={() => {
          api.clearAccessToken()
          setAccessToken('')
          navigate('/login')
        }} />
      </Suspense>
    )
  }
  if (path === '/account') {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <h1>Account session</h1>
          <p role="status">Checking your secure session…</p>
          <p><a href="/login">Sign in</a></p>
        </section>
      </main>
    )
  }

  async function submit(event) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (path === '/login' && challengeRequired) {
        const result = await api.login({ ...challengeCredentials, challengeToken: form.get('challengeToken') })
        if (result.loginAttemptId) {
          setAttemptId(result.loginAttemptId)
          setChallenge(true)
          setChallengeRequired(false)
          setNotice('Enter the code sent to your email address.')
        } else {
          setError('Complete the verification challenge and try again.')
        }
      } else if (path === '/login' && challenge) {
        const result = await api.verifyEmailCode({ email: form.get('email'), loginAttemptId: attemptId, code: form.get('code') })
        acceptAccessToken(result.accessToken)
        setNotice('You are signed in. Your access token is held in memory for this page.')
      } else if (path === '/login' && staffFactor) {
        const result = await api.staffLogin({ email: form.get('email'), password: form.get('password'), code: form.get('code') })
        acceptAccessToken(result.accessToken)
        setNotice('You are signed in. Your access token is held in memory for this page.')
      } else if (path === '/login') {
        const credentials = { email: form.get('email'), password: form.get('password') }
        const result = await api.login(credentials)
        if (result.challenge) {
          setChallengeCredentials(credentials)
          setChallengeRequired(true)
          setNotice('Complete the additional sign-in verification.')
          return
        }
        if (result.accessToken) {
          acceptAccessToken(result.accessToken)
        } else if (result.factor === 'email') {
          setAttemptId(result.loginAttemptId)
          setChallenge(true)
          setNotice('Enter the code sent to your email address.')
        } else if (result.factor === 'totp') {
          setStaffFactor(true)
          setNotice('Enter the current code from your authenticator app.')
        }
      } else if (path === '/register') {
        await api.register({ name: form.get('name'), phone: form.get('phone'), email: form.get('email'), password: form.get('password') })
        setNotice('Registration received. Check your email for verification instructions.')
      } else if (path === '/forgot-password') {
        await api.requestPasswordReset(form.get('email'))
        setNotice('If the address can be verified, password reset instructions will be sent.')
      } else {
        await api.resetPassword({ token: new URLSearchParams(window.location.search).get('token') || form.get('token'), password: form.get('password') })
        setNotice('Password updated. Please sign in again.')
      }
    } catch (cause) {
      setError(cause.payload?.error || 'The request could not be completed. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const labels = {
    '/login': 'Sign in',
    '/register': 'Create account',
    '/forgot-password': 'Reset your password',
    '/reset-password': 'Choose a new password',
  }
  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="auth-title">
        <p className="eyebrow">Secure account access</p>
        <h1 id="auth-title">{labels[path]}</h1>
        <form onSubmit={submit}>
          {path === '/register' && <label>Name<input name="name" autoComplete="name" required maxLength="150" /></label>}
          {path === '/register' && <label>Phone<input name="phone" autoComplete="tel" required /></label>}
          {path !== '/reset-password' && <label>Email<input name="email" type="email" autoComplete="email" required maxLength="255" /></label>}
          {path === '/login' && !challenge && <label>Password<input name="password" type="password" autoComplete="current-password" required minLength="12" maxLength="128" /></label>}
          {path === '/login' && challengeRequired && <label>Verification response<input name="challengeToken" required maxLength="4096" /></label>}
          {path === '/login' && (challenge || staffFactor) && <label>{staffFactor ? 'Authenticator code' : 'Email code'}<input name="code" inputMode="numeric" autoComplete="one-time-code" required pattern="\d{6}" /></label>}
          {path === '/reset-password' && <><label>Reset token<input name="token" required defaultValue={new URLSearchParams(window.location.search).get('token') || ''} /></label><label>New password<input name="password" type="password" autoComplete="new-password" required minLength="12" maxLength="128" /></label></>}
          {path === '/register' && <label>Password<input name="password" type="password" autoComplete="new-password" required minLength="12" maxLength="128" /></label>}
          <button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Please wait…' : labels[path]}</button>
        </form>
        {notice && <p role="status" className="auth-notice">{notice}</p>}
        {error && <p role="alert" className="auth-error">{error}</p>}
        {path === '/login' && !challenge && <p><a href="/forgot-password" onClick={(event) => { event.preventDefault(); navigate('/forgot-password') }}>Forgot password?</a></p>}
        {path === '/login' && <p>New to Poshaak? <a href="/register" onClick={(event) => { event.preventDefault(); navigate('/register') }}>Create an account</a></p>}
        {path === '/register' && <p>Already registered? <a href="/login" onClick={(event) => { event.preventDefault(); navigate('/login') }}>Sign in</a></p>}
      </section>
      <p className="auth-footnote">Staff accounts use an authenticator app. Protected API access is available to the current page session only.</p>
    </main>
  )
}

export default AuthScreen
