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
import AdminSellerPayouts from './AdminSellerPayouts.jsx'
import AdminSellerPayoutDetail from './AdminSellerPayoutDetail.jsx'
import AdminHeldFunds from './AdminHeldFunds.jsx'
import AdminPayoutSettings from './AdminPayoutSettings.jsx'
import AdminReviews from './AdminReviews.jsx'
import AdminReturns from './AdminReturns.jsx'
import AdminChargebacks from './AdminChargebacks.jsx'
import AdminConsistency from './AdminConsistency.jsx'
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

function sellerPayoutIdFromPath(path) {
  const match = /^\/admin\/seller-payouts\/([^/]+)$/.exec(path)
  return match ? match[1] : ''
}

function returnIdFromPath(path) {
  const match = /^\/admin\/returns\/([^/]+)$/.exec(path)
  return match ? match[1] : ''
}

function chargebackIdFromPath(path) {
  const match = /^\/admin\/chargebacks\/([^/]+)$/.exec(path)
  return match ? match[1] : ''
}

function adminIdFromAccessToken(token) {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const claims = JSON.parse(atob(padded))
    return typeof claims.sub === 'string' ? claims.sub : null
  } catch {
    return null
  }
}

export default function AdminApp({ path }) {
  const [sessionState, setSessionState] = useState('checking')
  const [sessionMessage, setSessionMessage] = useState('')
  const [currentAdminId, setCurrentAdminId] = useState(null)
  const [currentRole, setCurrentRole] = useState(null)

  useEffect(() => {
    let active = true
    async function restoreSession() {
      try {
        const session = await api.refresh()
        if (!active) return
        api.setAccessToken(session.accessToken)
        setCurrentAdminId(adminIdFromAccessToken(session.accessToken))
        setCurrentRole(session.role || null)
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
          setCurrentAdminId(null)
          setCurrentRole(null)
          setSessionState('signed-out')
          setSessionMessage(`This account cannot use the Admin area.${logoutMessage}`)
          return
        }
        api.clearAccessToken()
        setCurrentAdminId(null)
        setCurrentRole(null)
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

  async function acceptAuthenticatedToken(token, role) {
    api.setAccessToken(token)
    setCurrentAdminId(adminIdFromAccessToken(token))
    setCurrentRole(role || null)
    try {
      await api.getAdminOrders({ limit: 1 })
      setSessionState('ready')
      setSessionMessage('')
      return { allowed: true }
    } catch (error) {
      if (!isAdminOrderAccessError(error)) {
        api.clearAccessToken()
        setCurrentAdminId(null)
        setCurrentRole(null)
        throw error
      }
      let logoutMessage = ''
      try {
        await api.logout()
      } catch (logoutError) {
        logoutMessage = ` Sign-out could not be completed: ${adminErrorMessage(logoutError)}`
      }
      api.clearAccessToken()
      setCurrentAdminId(null)
      setCurrentRole(null)
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
    setCurrentAdminId(null)
    setCurrentRole(null)
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
  const sellerPayoutId = sellerPayoutIdFromPath(path)
  const returnId = returnIdFromPath(path)
  const chargebackId = chargebackIdFromPath(path)
  let page
  if (orderId) page = <AdminOrders orderId={orderId} />
  else if (path === '/admin/refunds/request') page = <AdminRefundRequest />
  else if (refundId) page = <AdminRefundDecision refundId={refundId} />
  else if (path === '/admin/refunds') page = <AdminRefunds />
  else if (sellerPayoutId) page = <AdminSellerPayoutDetail payoutId={sellerPayoutId} currentAdminId={currentAdminId} />
  else if (path === '/admin/seller-payouts') page = <AdminSellerPayouts />
  else if (path === '/admin/held-funds') page = <AdminHeldFunds />
  else if (path === '/admin/payout-settings') page = <AdminPayoutSettings />
  else if (path === '/admin/exceptions') page = <AdminExceptions />
  else if (path === '/admin/disputes') page = <AdminDisputes />
  else if (path === '/admin/delivery-cities') page = <AdminDeliveryCities />
  else if (path === '/admin/reviews') page = <AdminReviews />
  else if (returnId) page = <AdminReturns returnId={returnId} />
  else if (path === '/admin/returns') page = <AdminReturns />
  else if (chargebackId) page = <AdminChargebacks chargebackId={chargebackId} />
  else if (path === '/admin/chargebacks') page = <AdminChargebacks />
  else if (path === '/admin/consistency') page = <AdminConsistency />
  else page = <AdminOrders />

  return <AdminLayout onLogout={signOut} role={currentRole}>{page}</AdminLayout>
}
