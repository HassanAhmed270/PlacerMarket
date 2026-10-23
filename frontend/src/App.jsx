import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import AccountWorkspace from './AccountWorkspace.jsx'
import ListingWorkspace, { PublicListingDetail } from './ListingWorkspace.jsx'
import './App.css'

function App() {
  const path = window.location.pathname
  const isAuthRoute = ['/login', '/register', '/forgot-password', '/reset-password', '/account'].includes(path)
  const [categories, setCategories] = useState([])
  const [categoryState, setCategoryState] = useState('loading')

  useEffect(() => {
    if (isAuthRoute) return undefined
    let active = true

    api.getMainCategories()
      .then((result) => {
        if (!active) return
        setCategories(Array.isArray(result) ? result : [])
        setCategoryState('ready')
      })
      .catch(() => {
        if (active) setCategoryState('unavailable')
      })

    return () => {
      active = false
    }
  }, [isAuthRoute])

  if (isAuthRoute) return <AuthScreen />
  if (path === '/seller/listings' || path === '/moderation') {
    return <ListingWorkspace path={path} onSignOut={async () => {
      try { await api.logout() } catch { /* Expired sessions are cleared locally too. */ }
      api.clearAccessToken()
      window.location.assign('/login')
    }} />
  }
  const publicListing = /^\/listing\/([^/]+)$/.exec(path)
  if (publicListing) return <PublicListingDetail id={decodeURIComponent(publicListing[1])} />

  return (
    <div className="site-shell">
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="Poshaak home">
          <span className="wordmark-mark" aria-hidden="true">P</span>
          <span>Poshaak</span>
        </a>
        <nav className="main-nav" aria-label="Main navigation">
          <a href="#categories">Explore</a>
          <a href="#about">About</a>
          <a className="nav-sell" href="/seller/listings">Sell with us</a>
          <a href="/moderation">Moderation</a>
        </nav>
      </header>

      <main id="top">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="eyebrow"><span /> The Poshaak marketplace</p>
              <h1 id="hero-title">Your website workspace is ready.</h1>
            <p className="hero-description">
              This responsive preview is connected to the public catalog API and ready for continued UI development.
            </p>
            <a className="button button-primary" href="#categories">
              Explore categories <span aria-hidden="true">↗</span>
            </a>
            <p className="preview-note">Website preview · browsing foundation</p>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="art-orbit orbit-one" />
            <div className="art-orbit orbit-two" />
            <div className="art-card">
            <span className="art-card-label">Frontend preview</span>
              <span className="art-card-flower">✳</span>
            <span className="art-card-caption">Browse interface foundation</span>
            </div>
            <span className="art-spark spark-one">✦</span>
            <span className="art-spark spark-two">✧</span>
          </div>
        </section>

        <section className="category-section" id="categories" aria-labelledby="categories-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Start somewhere lovely</p>
              <h2 id="categories-title">Public catalog</h2>
            </div>
            <span className="section-index">01 / Browse</span>
          </div>

          {categoryState === 'loading' && (
            <p className="category-message" role="status">Loading categories…</p>
          )}
          {categoryState === 'unavailable' && (
            <p className="category-message" role="status">
              Categories will appear here when the development API is available.
            </p>
          )}
          {categoryState === 'ready' && categories.length === 0 && (
            <p className="category-message" role="status">No categories are available yet.</p>
          )}
          {categoryState === 'ready' && categories.length > 0 && (
            <ul className="category-list">
              {categories.map((category, index) => (
                <li className="category-card" key={category.id}>
                  <span className="category-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                  <span>{category.name}</span>
                  <span className="category-arrow" aria-hidden="true">↗</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="about-section" id="about" aria-labelledby="about-title">
          <p className="eyebrow">Made for discovery</p>
          <h2 id="about-title">Development preview</h2>
          <p>Sign in to create listings and manage your seller workspace.</p>
        </section>

        <p className="seller-note" id="seller-note">
          <a href="/seller/listings">Open seller studio</a> · <a href="/moderation">Open moderation desk</a>
        </p>
      </main>

      <footer className="site-footer">
        <a className="wordmark footer-wordmark" href="#top">Poshaak</a>
        <span>Frontend foundation</span>
      </footer>
    </div>
  )
}

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
    if (path !== '/login' && path !== '/account') return
    api.refresh().then((result) => {
      api.setAccessToken(result.accessToken)
      setAccessToken(result.accessToken)
    }).catch(() => {})
  }, [path])

  function acceptAccessToken(token) {
    api.setAccessToken(token)
    setAccessToken(token)
    window.history.pushState({}, '', '/account')
    setPath('/account')
  }

  if (accessToken) return <AccountWorkspace onSignOut={() => { api.clearAccessToken(); setAccessToken(''); navigate('/login') }} />
  if (path === '/account') return <main className="auth-shell"><a className="wordmark" href="/">Poshaak</a><section className="auth-card"><h1>Account session</h1><p role="status">Checking your secure session…</p><p><a href="/login">Sign in</a></p></section></main>

  function navigate(next) {
    window.history.pushState({}, '', next)
    setPath(next)
    setNotice('')
    setError('')
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
    } finally { setBusy(false) }
  }

  const labels = { '/login': 'Sign in', '/register': 'Create account', '/forgot-password': 'Reset your password', '/reset-password': 'Choose a new password' }
  return (
    <main className="auth-shell">
      <a className="wordmark" href="/">Poshaak</a>
      <section className="auth-card" aria-labelledby="auth-title">
        <p className="eyebrow">Secure account access</p>
        <h1 id="auth-title">{labels[path]}</h1>
        <form onSubmit={submit}>
          {path === '/register' && <label>Name<input name="name" autoComplete="name" required maxLength="150" /></label>}
          {(path === '/register') && <label>Phone<input name="phone" autoComplete="tel" required /></label>}
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
        {accessToken && <span className="sr-only" aria-label="Signed in" />}
      </section>
      <p className="auth-footnote">Staff accounts use an authenticator app. Protected API access is available to the current page session only.</p>
    </main>
  )
}

export default App
