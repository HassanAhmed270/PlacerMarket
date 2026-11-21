import { useState } from 'react'
import { visibleAdminLinks } from './lib/adminNavigation.js'

export default function AdminLayout({ children, onLogout, role }) {
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
          {visibleAdminLinks(role).map((link) => (
            <a key={link.href} href={link.href}>{link.label}</a>
          ))}
          <button className="admin-text-button" type="button" onClick={logout} disabled={logoutPending}>
            {logoutPending ? 'Signing out…' : 'Logout'}
          </button>
        </nav>
      </header>
      <div className="admin-content">{children}</div>
    </main>
  )
}
