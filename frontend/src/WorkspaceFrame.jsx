import { DEV_FAKES_BANNER } from './lib/api.js'

export function ErrorMessage({ children }) {
  return children ? <p className="workspace-error" role="alert">{children}</p> : null
}

function WorkspaceFrame({ children, onSignOut }) {
  return (
    <main className="account-shell listing-workspace">
      <header className="workspace-toolbar">
        <nav className="workspace-links">
          <a href="/seller/listings">My listings</a>
          <a href="/moderation">Moderation</a>
        </nav>
        {onSignOut && <button className="text-button" type="button" onClick={onSignOut}>Sign out</button>}
      </header>
      {DEV_FAKES_BANNER && <p className="auth-mock-banner" role="status">Development only: DEV_FAKES is enabled. Provider actions may be simulated.</p>}
      {children}
    </main>
  )
}

export default WorkspaceFrame
