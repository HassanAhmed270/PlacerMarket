export function ListingGrid({ listings = [] }) {
  if (!listings.length) return <p className="category-message" role="status">No listings are available yet.</p>

  return (
    <ul className="listing-grid">
      {listings.map((listing) => (
        <li className="listing-card" key={listing.id}>
          <a href={`/listing/${encodeURIComponent(listing.canonicalKey || listing.id)}`}>
            <div className="listing-card-image" aria-hidden="true"><span>Poshaak</span></div>
            <div className="listing-card-copy">
              <span className="listing-card-title">{listing.title}</span>
              <span className="listing-card-price">PKR {listing.asking_price}</span>
              {listing.reserved && <span className="reserved-badge">Reserved</span>}
              {listing.seller_city && <span className="listing-card-city">{listing.seller_city}</span>}
            </div>
          </a>
        </li>
      ))}
    </ul>
  )
}

export function BrowseState({ state, error, noun = 'listings' }) {
  if (state === 'loading') return <p className="category-message" role="status">Loading {noun}…</p>
  if (state === 'error') return <p className="workspace-error" role="alert">{error || `We couldn't load ${noun}. Please try again.`}</p>
  return null
}
