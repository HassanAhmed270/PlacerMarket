import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import WorkspaceFrame, { ErrorMessage } from './WorkspaceFrame.jsx'

function ModeratorImage({ src }) {
  const [objectUrl, setObjectUrl] = useState('')
  useEffect(() => {
    let active = true
    let createdUrl = ''
    if (src) api.getAuthenticatedImage(src).then((url) => {
      createdUrl = url
      if (active) setObjectUrl(url)
      else URL.revokeObjectURL(url)
    }).catch(() => {})
    return () => {
      active = false
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  }, [src])
  return objectUrl ? <img className="moderation-photo" src={objectUrl} alt="Processed seller photo" /> : <span>Photo processing or unavailable</span>
}

function ModerationWorkspace({ onSignOut }) {
  const [listings, setListings] = useState([])
  const [revisions, setRevisions] = useState([])
  const [reasons, setReasons] = useState({})
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  async function refresh() {
    const [listingQueue, revisionQueue] = await Promise.all([api.getListingModerationQueue(), api.getListingRevisionQueue()])
    setListings(listingQueue)
    setRevisions(revisionQueue)
  }

  useEffect(() => {
    let active = true
    Promise.all([api.getListingModerationQueue(), api.getListingRevisionQueue()])
      .then(([listingQueue, revisionQueue]) => {
        if (active) {
          setListings(listingQueue)
          setRevisions(revisionQueue)
        }
      })
      .catch((cause) => {
        if (active) setError(cause.payload?.error || cause.message)
      })
    return () => { active = false }
  }, [])

  async function run(action, done) {
    setError('')
    setMessage('')
    try {
      await action()
      setMessage(done)
      await refresh()
    } catch (cause) {
      setError(cause.payload?.error || cause.message)
    }
  }

  return (
    <WorkspaceFrame onSignOut={onSignOut}>
      <p className="eyebrow">Review desk</p>
      <h1>Moderation queue</h1>
      <ErrorMessage>{error}</ErrorMessage>
      {message && <p role="status">{message}</p>}
      <button className="text-button" type="button" onClick={() => refresh().catch((cause) => setError(cause.message))}>Refresh queues</button>
      <section className="listing-panel">
        <h2>Listings and photos</h2>
        {listings.map((listing) => (
          <article className="moderation-card" key={listing.id}>
            <h3>{listing.title}</h3>
            <p>PKR {listing.asking_price} · {listing.is_high_value ? 'High value' : 'Standard review'}</p>
            {listing.seo_choice === 'custom' && <p><strong>Seller SEO title:</strong> {listing.seo_title}<br /><strong>Seller SEO description:</strong> {listing.seo_description}</p>}
            <div className="moderation-photos">
              {(listing.photos || []).map((photo) => (
                <div key={photo.id}>
                  <ModeratorImage src={photo.imageUrl} />
                  <strong>{photo.slot || 'unlabeled'}</strong>
                  {photo.labelConfirmedAt ? <span>Confirmed</span> : (
                    <>
                      <button className="text-button" type="button" onClick={() => run(() => api.confirmListingPhoto(photo.id), 'Photo label confirmed.')}>Confirm label</button>
                      <label>Rejection reason<input value={reasons[photo.id] || ''} onChange={(event) => setReasons({ ...reasons, [photo.id]: event.target.value })} /></label>
                      <button className="text-button" type="button" disabled={!reasons[photo.id]} onClick={() => run(() => api.rejectListingPhoto(photo.id, reasons[photo.id]), 'Photo rejected with reason.')}>Reject photo</button>
                    </>
                  )}
                </div>
              ))}
            </div>
            <label>Listing rejection reason<input value={reasons[listing.id] || ''} onChange={(event) => setReasons({ ...reasons, [listing.id]: event.target.value })} /></label>
            <button className="button button-primary" type="button" onClick={() => run(() => api.approveListing(listing.id), 'Listing approved.')}>Approve listing</button>
            <button className="text-button" type="button" disabled={!reasons[listing.id]} onClick={() => run(() => api.rejectListing(listing.id, reasons[listing.id]), 'Listing rejected.')}>Reject listing</button>
          </article>
        ))}
      </section>
      <section className="listing-panel">
        <h2>Content revisions</h2>
        {revisions.map((revision) => (
          <article className="moderation-card" key={revision.id}>
            <h3>{revision.proposed_title}</h3>
            <p>PKR {revision.proposed_asking_price} · {revision.current_title}</p>
            {revision.proposed_seo_choice === 'custom' && <p><strong>Seller SEO title:</strong> {revision.proposed_seo_title}<br /><strong>Seller SEO description:</strong> {revision.proposed_seo_description}</p>}
            <button className="button button-primary" type="button" onClick={() => run(() => api.approveListingRevision(revision.id), 'Revision approved and published.')}>Approve revision</button>
            <label>Rejection reason<input value={reasons[revision.id] || ''} onChange={(event) => setReasons({ ...reasons, [revision.id]: event.target.value })} /></label>
            <button className="text-button" type="button" disabled={!reasons[revision.id]} onClick={() => run(() => api.rejectListingRevision(revision.id, reasons[revision.id]), 'Revision rejected.')}>Reject revision</button>
          </article>
        ))}
        {revisions.length === 0 && <p>No pending revisions.</p>}
      </section>
    </WorkspaceFrame>
  )
}

export default ModerationWorkspace
