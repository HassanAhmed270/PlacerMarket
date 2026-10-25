import { lazy, Suspense, useEffect, useState } from 'react'
import { SiteLayout } from './SiteLayout.jsx'
import './App.css'

const HomePage = lazy(() => import('./HomePage.jsx'))
const AuthScreen = lazy(() => import('./AuthScreen.jsx'))
const SearchPage = lazy(() => import('./SearchPage.jsx'))
const PublicListingDetail = lazy(() => import('./PublicListingDetail.jsx'))
const ProtectedWorkspace = lazy(() => import('./ListingWorkspace.jsx'))

const authRoutes = new Set(['/login', '/register', '/forgot-password', '/reset-password', '/account'])

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
  } else if (path === '/search') {
    page = <SearchPage />
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
    const publicListing = /^\/listing\/([^/]+)$/.exec(path)
    page = publicListing
      ? <PublicListingDetail id={decodeURIComponent(publicListing[1])} />
      : <HomePage />
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
