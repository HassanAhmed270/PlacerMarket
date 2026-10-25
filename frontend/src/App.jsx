import { lazy, Suspense, useEffect, useState } from 'react'
import { SiteLayout } from './SiteLayout.jsx'
import { api } from './lib/api.js'
import { getBuyDestination } from './lib/browse.js'
import './App.css'

const HomePage = lazy(() => import('./HomePage.jsx'))
const AuthScreen = lazy(() => import('./AuthScreen.jsx'))
const SearchPage = lazy(() => import('./SearchPage.jsx'))
const PublicListingDetail = lazy(() => import('./PublicListingDetail.jsx'))
const CategoryPage = lazy(() => import('./CategoryPage.jsx'))
const ProtectedWorkspace = lazy(() => import('./ListingWorkspace.jsx'))
const ProtectedCustomerWorkspace = lazy(() => import('./CustomerWorkspace.jsx'))
const StaticPage = lazy(() => import('./StaticPage.jsx'))

const authRoutes = new Set(['/login', '/register', '/forgot-password', '/reset-password', '/account'])
const staticPageRoutes = new Set(['/about', '/how-it-works', '/terms', '/privacy', '/help', '/contact'])

function CheckoutSoonPage() {
  const [allowed, setAllowed] = useState(api.isAuthenticated())
  const [error, setError] = useState('')
  const listingPath = new URLSearchParams(window.location.search).get('listing') || '/'

  useEffect(() => {
    if (allowed) return undefined
    let active = true
    api.refresh().then((result) => {
      if (!active) return
      api.setAccessToken(result.accessToken)
      setAllowed(true)
    }).catch((cause) => {
      if (!active) return
      if (cause.status === 401 || cause.status === 403) {
        const destination = getBuyDestination({ authenticated: false, listingPath })
        window.location.replace(destination.url)
      } else {
        setError(cause.message)
      }
    })
    return () => { active = false }
  }, [allowed, listingPath])

  if (!allowed) return <main className="route-loading" role="status">{error || 'Checking your account…'}</main>
  return <main className="checkout-soon"><p className="eyebrow">Poshaak marketplace</p><h1>Checkout opens soon</h1><p>Buying is coming soon. No payment or reservation has been made.</p><a className="button button-secondary" href={listingPath.startsWith('/listing/') && !listingPath.startsWith('//') ? listingPath : '/'}>Return to listing</a></main>
}

function App() {
  const [path, setPath] = useState(window.location.pathname)

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  let page
  if (authRoutes.has(path)) {
    page = <AuthScreen />
  } else if (path === '/favorites' || path === '/inbox' || path === '/notifications') {
    page = <ProtectedCustomerWorkspace path={path} />
  } else if (/^\/inbox\/[^/]+$/.test(path)) {
    page = <ProtectedCustomerWorkspace path={path} conversationId={decodeURIComponent(path.slice('/inbox/'.length))} />
  } else if (staticPageRoutes.has(path)) {
    page = <StaticPage page={path.slice(1)} />
  } else if (path === '/search') {
    page = <SearchPage />
  } else if (path === '/categories') {
    page = <CategoryPage />
  } else if (path === '/checkout/soon') {
    page = <CheckoutSoonPage />
  } else if (path === '/seller/listings' || path === '/moderation') {
    page = (
      <ProtectedWorkspace
        path={path}
        onSignOut={async () => {
          const { api } = await import('./lib/api.js')
          try {
            await api.logout()
          } catch {
            // Expired sessions are cleared locally too.
          }
          api.clearAccessToken()
          window.location.assign('/login')
        }}
      />
    )
  } else {
    const categoryCity = /^\/category\/([^/]+)\/city\/([^/]+)$/.exec(path)
    const categorySub = /^\/category\/([^/]+)\/([^/]+)$/.exec(path)
    const categoryMain = /^\/category\/([^/]+)$/.exec(path)
    const publicListing = /^\/listing\/([^/]+)$/.exec(path)
    if (publicListing) page = <PublicListingDetail id={decodeURIComponent(publicListing[1])} />
    else if (categoryCity) page = <CategoryPage mainCategoryId={decodeURIComponent(categoryCity[1])} cityId={decodeURIComponent(categoryCity[2])} />
    else if (categorySub) page = <CategoryPage mainCategoryId={decodeURIComponent(categorySub[1])} subCategoryId={decodeURIComponent(categorySub[2])} />
    else if (categoryMain) page = <CategoryPage mainCategoryId={decodeURIComponent(categoryMain[1])} />
    else page = path === '/' ? <HomePage /> : <main className="unavailable-page"><p className="eyebrow">Poshaak marketplace</p><h1>Page unavailable</h1><p>This page could not be found.</p><a href="/">Return home</a></main>
  }

  return (
    <SiteLayout>
      <Suspense fallback={<main className="route-loading" role="status">Loading page…</main>}>
        {page}
      </Suspense>
    </SiteLayout>
  )
}

export default App
