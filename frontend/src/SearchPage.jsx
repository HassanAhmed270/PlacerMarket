import { useEffect, useState } from 'react'
import { api } from './lib/api.js'

function SearchPage() {
  const query = new URLSearchParams(window.location.search).get('q')?.trim() || ''
  const [results, setResults] = useState(() => query ? null : { items: [] })
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    if (!query) return () => { active = false }
    api.searchListings(query).then((result) => {
      if (active) setResults(result)
    }).catch((cause) => {
      if (active) setError(cause.payload?.error || cause.message)
    })
    return () => { active = false }
  }, [query])

  return (
    <main className="category-section search-page" aria-labelledby="search-title">
      <p className="eyebrow">Poshaak marketplace</p>
      <h1 id="search-title">Search results{query ? ` for “${query}”` : ''}</h1>
      {error && <p className="workspace-error" role="alert">{error}</p>}
      {!results && !error && <p className="category-message" role="status">Searching the catalog…</p>}
      {results?.items?.length === 0 && <p className="category-message" role="status">No matching listings were found.</p>}
      {results?.items?.length > 0 && (
        <ul className="search-results">
          {results.items.map((listing) => (
            <li className="search-result" key={listing.id}>
              <a href={`/listing/${encodeURIComponent(listing.id)}`}>
                <span className="search-result-title">{listing.title}</span>
                <span>PKR {listing.asking_price}</span>
                {listing.reserved && <span className="reserved-badge">Reserved</span>}
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

export default SearchPage
