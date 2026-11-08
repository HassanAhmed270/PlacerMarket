import { useState } from 'react'

export default function AdminLayout({ children, onLogout }) {
  const [logoutPending, setLogoutPending] = useState(false)

  async function logout() {
    setLogoutPending(true)
    try {
      await onLogout()
    } finally {
      setLogoutPending(false)
    }
  }

  return (
    <main className="admin-screen admin-workspace">
      <header className="admin-header">
        <a className="admin-brand" href="/admin/orders">Poshaak Admin</a>
        <nav className="admin-nav" aria-label="Admin navigation">
          <a href="/admin/orders">Orders</a>
          <a href="/admin/exceptions">Exceptions</a>
          <a href="/admin/disputes">Disputes</a>
          <a href="/admin/refunds">Refunds</a>
          <a href="/admin/delivery-cities">Delivery cities</a>
          <button className="admin-text-button" type="button" onClick={logout} disabled={logoutPending}>
            {logoutPending ? 'Signing out…' : 'Logout'}
          </button>
        </nav>
      </header>
      <div className="admin-content">{children}</div>
    </main>
  )
}
