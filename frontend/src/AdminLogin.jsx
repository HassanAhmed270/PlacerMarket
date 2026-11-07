import { useState } from 'react'
import { api } from './lib/api.js'
import { adminLoginErrorMessage } from './lib/admin.js'

export default function AdminLogin({ initialMessage = '', onAuthenticated }) {
  const [factorRequired, setFactorRequired] = useState(false)
  const [credentials, setCredentials] = useState(null)
  const [message, setMessage] = useState(initialMessage)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

  async function submit(event) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    setError('')
    setMessage('')
    try {
      if (!factorRequired) {
        const nextCredentials = {
          email: String(form.get('email') || '').trim(),
          password: String(form.get('password') || ''),
        }
        const result = await api.login(nextCredentials)
        if (result.accessToken) {
          await completeLogin(result.accessToken)
        } else if (result.factor === 'totp') {
          setCredentials(nextCredentials)
          setFactorRequired(true)
          setMessage('Enter the current code from your authenticator app.')
        } else {
          setCredentials(null)
          setError('This account cannot use the Admin area')
        }
      } else {
        const code = String(form.get('code') || '')
        const result = await api.staffLogin({ ...credentials, code })
        await completeLogin(result.accessToken)
      }
    } catch (cause) {
      setError(adminLoginErrorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  async function completeLogin(token) {
    try {
      const result = await onAuthenticated(token)
      setCredentials(null)
      if (!result.allowed) {
        setFactorRequired(false)
        setError(result.message)
      }
    } catch (cause) {
      setCredentials(null)
      setFactorRequired(false)
      throw cause
    }
  }

  function restartLogin() {
    setFactorRequired(false)
    setCredentials(null)
    setMessage('')
    setError('')
  }

  return (
    <main className="admin-screen admin-login-screen">
      <section className="admin-card admin-login-card" aria-labelledby="admin-login-title">
        <p className="admin-eyebrow">Poshaak operations</p>
        <h1 id="admin-login-title">Admin sign in</h1>
        <form className="admin-form" onSubmit={submit}>
          {!factorRequired && (
            <>
              <label>Email<input name="email" type="email" autoComplete="username" required maxLength="255" /></label>
              <label>Password<input name="password" type="password" autoComplete="current-password" required minLength="12" maxLength="128" /></label>
            </>
          )}
          {factorRequired && (
            <label>Authenticator code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" required /></label>
          )}
          <button className="admin-button admin-button-primary" type="submit" disabled={pending}>
            {pending ? 'Please wait…' : factorRequired ? 'Verify and sign in' : 'Continue'}
          </button>
        </form>
        {factorRequired && <button className="admin-text-button" type="button" onClick={restartLogin} disabled={pending}>Use another account</button>}
        {message && <p className="admin-notice" role="status">{message}</p>}
        {error && <p className="admin-error" role="alert">{error}</p>}
      </section>
    </main>
  )
}
