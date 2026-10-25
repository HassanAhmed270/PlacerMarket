import { useEffect, useState } from 'react'
import { api } from './lib/api.js'

function PublicListingDetail({ id }) {
  const [listing, setListing] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const originalTitle = document.title
    const description = document.querySelector('meta[name="description"]')
    const originalDescription = description?.getAttribute('content')
    const canonical = document.querySelector('link[rel="canonical"]')
    const originalCanonical = canonical?.getAttribute('href')
    const meta = description || document.createElement('meta')
    const link = canonical || document.createElement('link')
    if (!description) {
      meta.name = 'description'
      document.head.append(meta)
    }
    if (!canonical) {
      link.rel = 'canonical'
      document.head.append(link)
    }
    api.getPublicListing(id).then((result) => {
      if (!active) return
      const canonicalPath = `/listing/${result.canonicalKey}`
      if (window.location.pathname !== canonicalPath) window.history.replaceState({}, '', canonicalPath)
      document.title = result.seo.choice.title
      meta.content = result.seo.choice.description
      link.href = new URL(result.canonicalUrl, window.location.origin).href
      setListing(result)
    }).catch((cause) => {
      if (active) setError(cause.payload?.error || cause.message)
    })
    return () => {
      active = false
      document.title = originalTitle
      if (description) {
        if (originalDescription === null) description.removeAttribute('content')
        else description.content = originalDescription
      } else {
        meta.remove()
      }
      if (canonical) {
        if (originalCanonical === null) canonical.removeAttribute('href')
        else canonical.href = originalCanonical
      } else {
        link.remove()
      }
    }
  }, [id])

  if (error) return <main className="account-shell"><h1>Listing unavailable</h1><p className="workspace-error" role="alert">{error}</p></main>
  if (!listing) return <main className="account-shell"><p role="status">Loading listing…</p></main>
  return (
    <main className="account-shell listing-workspace">
      <article className="listing-panel">
        <p className="eyebrow">Poshaak marketplace</p>
        <h1>{listing.title}</h1>
        <p className="listing-price">PKR {listing.asking_price}</p>
        <p>{listing.description}</p>
        <div className="moderation-photos">
          {(listing.images || []).map((image) => (
            <img key={image.id} className="moderation-photo" src={image.image_url} alt={`${listing.title} listing photo`} />
          ))}
        </div>
      </article>
    </main>
  )
}

export default PublicListingDetail
