function SiteHeader() {
  return (
    <header className="site-header">
      <a className="wordmark" href="/" aria-label="Poshaak home">
        <span className="wordmark-mark" aria-hidden="true">P</span>
        <span>Poshaak</span>
      </a>
      <form className="site-search" action="/search" role="search">
        <label className="sr-only" htmlFor="site-search">Search the marketplace</label>
        <input id="site-search" name="q" type="search" placeholder="Search clothing, brands…" />
        <button type="submit" aria-label="Search">Search</button>
      </form>
      <nav className="main-nav" aria-label="Main navigation">
        <a href="/#categories">Explore</a>
        <a href="/about">About</a>
        <a href="/favorites">Favorites</a>
        <a href="/inbox">Inbox</a>
        <a href="/notifications">Notifications</a>
        <a className="nav-sell" href="/seller/listings">Sell with us</a>
        <a href="/login">Sign in</a>
      </nav>
    </header>
  )
}

function SiteFooter() {
  return (
    <footer className="site-footer">
      <a className="wordmark footer-wordmark" href="/" aria-label="Poshaak home">Poshaak</a>
      <nav className="footer-nav" aria-label="Footer navigation">
        <a href="/#categories">Explore</a>
        <a href="/about">About</a>
        <a href="/how-it-works">How it works</a>
        <a href="/terms">Terms</a>
        <a href="/privacy">Privacy</a>
        <a href="/help">Help</a>
        <a href="/contact">Contact</a>
        <a href="/seller/listings">Sell with us</a>
        <a href="/login">Sign in</a>
      </nav>
      <span>Poshaak marketplace</span>
    </footer>
  )
}

export function SiteLayout({ children }) {
  return (
    <div className="site-shell">
      <SiteHeader />
      {children}
      <SiteFooter />
    </div>
  )
}
