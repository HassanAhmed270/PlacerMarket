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
  const [attributeQueue, setAttributeQueue] = useState([])
  const [reasons, setReasons] = useState({})
  const [error, setError] = useState('')
  const [attributeQueueError, setAttributeQueueError] = useState('')
  const [message, setMessage] = useState('')

  async function refresh() {
    const [listingResult, revisionResult, attributeResult] = await Promise.allSettled([
      api.getListingModerationQueue(), api.getListingRevisionQueue(), api.getManagedAttributeApprovalQueue(),
    ])
    if (listingResult.status === 'rejected') throw listingResult.reason
    if (revisionResult.status === 'rejected') throw revisionResult.reason
    setListings(listingResult.value)
    setRevisions(revisionResult.value)
    if (attributeResult.status === 'fulfilled') {
      setAttributeQueue(attributeResult.value)
      setAttributeQueueError('')
    } else {
      setAttributeQueueError(attributeResult.reason.payload?.error || attributeResult.reason.message)
    }
  }

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      refresh().catch((cause) => { if (active) setError(cause.payload?.error || cause.message) })
    }, 0)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
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
        <h2>Listings, photos, and SEO text review</h2>
        {listings.map((listing) => (
          <article className="moderation-card" key={listing.id}>
            <h3>{listing.title}</h3>
            <p>PKR {listing.asking_price} · {listing.is_high_value ? 'High value' : 'Standard review'}</p>
            <div className="seo-review">
              <strong>SEO text · {listing.seo_choice === 'custom' ? 'Seller-written — review' : 'System recommendation'}</strong>
              {listing.seo_choice === 'custom'
                ? <p><strong>Seller SEO title:</strong> {listing.seo_title}<br /><strong>Seller SEO description:</strong> {listing.seo_description}</p>
                : <p>Recommendation is based on listing details and seller city.</p>}
            </div>
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
        <h2>Content revisions and SEO text review</h2>
        {revisions.map((revision) => (
          <article className="moderation-card" key={revision.id}>
            <h3>{revision.proposed_title}</h3>
            <p>PKR {revision.proposed_asking_price} · {revision.current_title}</p>
            <div className="seo-review">
              <strong>SEO text · {revision.proposed_seo_choice === 'custom' ? 'Seller-written — review' : 'System recommendation'}</strong>
              {revision.proposed_seo_choice === 'custom'
                ? <p><strong>Seller SEO title:</strong> {revision.proposed_seo_title}<br /><strong>Seller SEO description:</strong> {revision.proposed_seo_description}</p>
                : <p>Recommendation is based on listing details and seller city.</p>}
            </div>
            <button className="button button-primary" type="button" onClick={() => run(() => api.approveListingRevision(revision.id), 'Revision approved and published.')}>Approve revision</button>
            <label>Rejection reason<input value={reasons[revision.id] || ''} onChange={(event) => setReasons({ ...reasons, [revision.id]: event.target.value })} /></label>
            <button className="text-button" type="button" disabled={!reasons[revision.id]} onClick={() => run(() => api.rejectListingRevision(revision.id, reasons[revision.id]), 'Revision rejected.')}>Reject revision</button>
          </article>
        ))}
        {revisions.length === 0 && <p>No pending revisions.</p>}
      </section>
      <section className="listing-panel">
        <h2>Custom attribute approval queue</h2>
        <p>Approved values become available in seller choices and catalog filters.</p>
        <ErrorMessage>{attributeQueueError}</ErrorMessage>
        {attributeQueue.map((item) => (
          <article className="moderation-card" key={item.id}>
            <h3>{item.value}</h3>
            <p>{item.attribute_type} · Pending approval</p>
            <button className="button button-primary" type="button" onClick={() => run(() => api.approveManagedAttribute(item.id), 'Custom catalog value approved.')}>Approve value</button>
            <label>Rejection reason<input value={reasons[item.id] || ''} maxLength="500" onChange={(event) => setReasons({ ...reasons, [item.id]: event.target.value })} /></label>
            <button className="text-button" type="button" disabled={!reasons[item.id]?.trim()} onClick={() => run(() => api.rejectManagedAttribute(item.id, reasons[item.id]), 'Custom catalog value rejected.')}>Reject value</button>
          </article>
        ))}
        {attributeQueue.length === 0 && !attributeQueueError && <p>No custom values awaiting approval.</p>}
      </section>
    </WorkspaceFrame>
  )
}

export default ModerationWorkspace
