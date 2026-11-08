import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import { adminErrorMessage } from './lib/admin.js'
import AdminLogin from './AdminLogin.jsx'
import AdminLayout from './AdminLayout.jsx'
import AdminOrders from './AdminOrders.jsx'
import AdminExceptions from './AdminExceptions.jsx'
import AdminDisputes from './AdminDisputes.jsx'
import AdminDeliveryCities from './AdminDeliveryCities.jsx'
import AdminRefunds from './AdminRefunds.jsx'
import AdminRefundRequest from './AdminRefundRequest.jsx'
import AdminRefundDecision from './AdminRefundDecision.jsx'
import './AdminWorkspace.css'

function isAdminOrderAccessError(error) {
  return error?.status === 401 || error?.status === 403
}

function orderIdFromPath(path) {
  const match = /^\/admin\/orders\/([^/]+)$/.exec(path)
  return match ? match[1] : ''
}

function refundIdFromPath(path) {
  const match = /^\/admin\/refunds\/([^/]+)$/.exec(path)
  return match && match[1] !== 'request' ? match[1] : ''
}

export default function AdminApp({ path }) {
  const [sessionState, setSessionState] = useState('checking')
  const [sessionMessage, setSessionMessage] = useState('')

  useEffect(() => {
    let active = true
    async function restoreSession() {
      try {
        const session = await api.refresh()
        if (!active) return
        api.setAccessToken(session.accessToken)
        await api.getAdminOrders({ limit: 1 })
        if (active) setSessionState('ready')
      } catch (error) {
        if (!active) return
        if (error?.status === 403 && api.isAuthenticated()) {
          let logoutMessage = ''
          try {
            await api.logout()
          } catch (logoutError) {
            logoutMessage = ` Sign-out could not be completed: ${adminErrorMessage(logoutError)}`
          }
          if (!active) return
          api.clearAccessToken()
          setSessionState('signed-out')
          setSessionMessage(`This account cannot use the Admin area.${logoutMessage}`)
          return
        }
        api.clearAccessToken()
        if (isAdminOrderAccessError(error)) {
          setSessionState('signed-out')
          setSessionMessage('Sign in with an Admin account to continue.')
        } else {
          setSessionState('error')
          setSessionMessage(adminErrorMessage(error))
        }
      }
    }
    restoreSession()
    return () => { active = false }
  }, [])

  async function acceptAuthenticatedToken(token) {
    api.setAccessToken(token)
    try {
      await api.getAdminOrders({ limit: 1 })
      setSessionState('ready')
      setSessionMessage('')
      return { allowed: true }
    } catch (error) {
      if (!isAdminOrderAccessError(error)) {
        api.clearAccessToken()
        throw error
      }
      let logoutMessage = ''
      try {
        await api.logout()
      } catch (logoutError) {
        logoutMessage = ` Sign-out could not be completed: ${adminErrorMessage(logoutError)}`
      }
      api.clearAccessToken()
      return {
        allowed: false,
        message: `This account cannot use the Admin area.${logoutMessage}`,
      }
    }
  }

  async function signOut() {
    let message = ''
    try {
      await api.logout()
    } catch (error) {
      message = `Your local session was cleared, but server sign-out could not be confirmed: ${adminErrorMessage(error)}`
    }
    api.clearAccessToken()
    setSessionState('signed-out')
    setSessionMessage(message)
  }

  if (sessionState === 'checking') {
    return <main className="admin-screen" role="status">Checking your secure Admin session…</main>
  }
  if (sessionState === 'error') {
    return (
      <main className="admin-screen">
        <h1>Admin area unavailable</h1>
        <p role="alert">{sessionMessage}</p>
        <button className="admin-button" type="button" onClick={() => window.location.reload()}>Retry</button>
      </main>
    )
  }
  if (sessionState !== 'ready') {
    return <AdminLogin initialMessage={sessionMessage} onAuthenticated={acceptAuthenticatedToken} />
  }

  const orderId = orderIdFromPath(path)
  const refundId = refundIdFromPath(path)
  let page
  if (orderId) page = <AdminOrders orderId={orderId} />
  else if (path === '/admin/refunds/request') page = <AdminRefundRequest />
  else if (refundId) page = <AdminRefundDecision refundId={refundId} />
  else if (path === '/admin/refunds') page = <AdminRefunds />
  else if (path === '/admin/exceptions') page = <AdminExceptions />
  else if (path === '/admin/disputes') page = <AdminDisputes />
  else if (path === '/admin/delivery-cities') page = <AdminDeliveryCities />
  else page = <AdminOrders />

  return <AdminLayout onLogout={signOut}>{page}</AdminLayout>
}
