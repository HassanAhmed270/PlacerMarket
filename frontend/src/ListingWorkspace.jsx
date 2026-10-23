import { useEffect, useState } from 'react'
import { api, DEV_FAKES_BANNER } from './lib/api.js'

const SLOT_LABELS = [
  ['front', 'Front (required)'], ['back', 'Back (required)'], ['other', 'Other / detail (required)'],
  ['optional_1', 'Optional photo 1'], ['optional_2', 'Optional photo 2'], ['optional_3', 'Optional photo 3'],
]

function ErrorMessage({ children }) {
  return children ? <p className="workspace-error" role="alert">{children}</p> : null
}

function ProtectedWorkspace({ path, onSignOut }) {
  const [state, setState] = useState('checking')
  const [token, setToken] = useState('')

  useEffect(() => {
    let active = true
    api.refresh().then((result) => {
      if (!active) return
      api.setAccessToken(result.accessToken)
      setToken(result.accessToken)
      setState('ready')
    }).catch(() => {
      if (active) setState('signed-out')
    })
    return () => { active = false }
  }, [])

  if (state === 'checking') return <WorkspaceFrame><p role="status">Restoring your secure session…</p></WorkspaceFrame>
  if (state === 'signed-out') return <WorkspaceFrame><h1>Sign in to continue</h1><p>Your secure session has expired.</p><a className="button button-primary" href="/login">Sign in</a></WorkspaceFrame>
  if (path === '/seller/listings') return <SellerListings key={token} onSignOut={onSignOut} />
  if (path === '/moderation') return <ModerationWorkspace onSignOut={onSignOut} />
  return <WorkspaceFrame><h1>Workspace not found</h1><a href="/">Return to Poshaak</a></WorkspaceFrame>
}

function WorkspaceFrame({ children, onSignOut }) {
  return (
    <main className="account-shell listing-workspace">
      <header className="account-header">
        <a className="wordmark" href="/">Poshaak</a>
        <nav className="workspace-links"><a href="/seller/listings">My listings</a><a href="/moderation">Moderation</a></nav>
        {onSignOut && <button className="text-button" type="button" onClick={onSignOut}>Sign out</button>}
      </header>
      {DEV_FAKES_BANNER && <p className="auth-mock-banner" role="status">Development only: DEV_FAKES is enabled. Provider actions may be simulated.</p>}
      {children}
    </main>
  )
}

function SellerListings({ onSignOut }) {
  const [listings, setListings] = useState([])
  const [categories, setCategories] = useState([])
  const [subCategories, setSubCategories] = useState([])
  const [conditions, setConditions] = useState([])
  const [fields, setFields] = useState([])
  const [revisions, setRevisions] = useState({})
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [uploadState, setUploadState] = useState('')
  const [selectedListing, setSelectedListing] = useState('')

  async function refresh() {
    const result = await api.getMyListings()
    setListings(result)
    const history = await Promise.all(result.filter((item) => item.published_at).map(async (item) => [item.id, await api.getListingRevisions(item.id)]))
    setRevisions(Object.fromEntries(history))
  }

  useEffect(() => {
    let active = true
    Promise.all([api.getMainCategories(), api.getConditionTypes(), api.getMyListings()])
      .then(async ([main, conditionList, own]) => {
        if (!active) return
        setCategories(main)
        setConditions(conditionList)
        setListings(own)
        const history = await Promise.all(own.filter((item) => item.published_at).map(async (item) => [item.id, await api.getListingRevisions(item.id)]))
        if (active) setRevisions(Object.fromEntries(history))
      }).catch((cause) => { if (active) setError(cause.payload?.error || cause.message) })
    return () => { active = false }
  }, [])

  async function chooseMainCategory(id) {
    setSubCategories([])
    setFields([])
    if (!id) return
    try { setSubCategories(await api.getSubCategories(id)) } catch (cause) { setError(cause.payload?.error || cause.message) }
  }

  async function chooseSubCategory(id) {
    setFields([])
    if (!id) return
    try { setFields(await api.getMeasurementFields(id)) } catch (cause) { setError(cause.payload?.error || cause.message) }
  }

  async function createAndSubmit(event) {
    event.preventDefault()
    const formElement = event.currentTarget
    setBusy(true); setError(''); setMessage('')
    const form = new FormData(formElement)
    const measurements = fields.flatMap((field) => {
      const value = String(form.get(`measurement:${field.id}`) || '').trim()
      return value ? [{ fieldDefId: field.id, value: Number(value) }] : []
    })
    const input = {
      title: form.get('title'), mainCategoryId: form.get('mainCategoryId'), subCategoryId: form.get('subCategoryId'),
      condition: form.get('condition'), askingPrice: Number(form.get('askingPrice')),
      description: form.get('description') || undefined,
      replicaDisclosure: form.get('replicaDisclosure') || undefined,
      fabricMaterial: form.get('fabricMaterial') || undefined, brand: form.get('brand') || undefined,
      color: form.get('color') || undefined, embellishmentDetail: form.get('embellishmentDetail') || undefined,
      measurements,
    }
    try {
      const listing = await api.createListing(input)
      for (const [slot, label] of SLOT_LABELS) {
        const file = form.get(`photo:${slot}`)
        if (!(file instanceof File) || !file.size) continue
        setUploadState(`Uploading ${label}…`)
        await api.uploadListingImage(listing.id, slot, file)
      }
      setUploadState('Waiting for photo processing…')
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const own = await api.getMyListings()
        const current = own.find((item) => item.id === listing.id)
        const required = current?.photos?.filter((photo) => ['front', 'back', 'other'].includes(photo.slot)) || []
        if (required.length === 3 && required.every((photo) => photo.processingState === 'ready')) break
        await new Promise((resolve) => window.setTimeout(resolve, 1000))
      }
      await api.submitListing(listing.id)
      formElement.reset()
      setUploadState('')
      setMessage('Listing submitted to the moderation queue.')
      await refresh()
    } catch (cause) {
      setError(cause.payload?.error || cause.message || 'The listing could not be submitted.')
    } finally { setBusy(false); setUploadState('') }
  }

  async function createRevision(event) {
    event.preventDefault()
    const formElement = event.currentTarget
    setBusy(true); setError(''); setMessage('')
    const form = new FormData(formElement)
    try {
      const result = await api.submitListingRevision(selectedListing, {
        title: form.get('revisionTitle') || undefined,
        description: form.get('revisionDescription') || undefined,
        askingPrice: form.get('revisionPrice') ? Number(form.get('revisionPrice')) : undefined,
      })
      setMessage(`Revision ${result.id} is awaiting moderation.`)
      formElement.reset()
      await refresh()
    } catch (cause) { setError(cause.payload?.error || cause.message) }
    finally { setBusy(false) }
  }

  async function withdraw(revisionId) {
    setBusy(true); setError(''); setMessage('')
    try { await api.withdrawListingRevision(revisionId); setMessage('Pending revision withdrawn.'); await refresh() }
    catch (cause) { setError(cause.payload?.error || cause.message) }
    finally { setBusy(false) }
  }

  return (
    <WorkspaceFrame onSignOut={onSignOut}>
      <section className="listing-panel">
        <p className="eyebrow">Seller studio</p><h1>Create a listing</h1>
        <p>Fill the required photo slots, wait for processing, then submit the listing for review.</p>
        <ErrorMessage>{error}</ErrorMessage>{message && <p role="status">{message}</p>}{uploadState && <p role="status">{uploadState}</p>}
        <form className="listing-form" onSubmit={createAndSubmit}>
          <label>Title<input name="title" required maxLength="150" /></label>
          <label>Main category<select name="mainCategoryId" required onChange={(event) => chooseMainCategory(event.target.value)}><option value="">Choose a category</option>{categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>Sub-category<select name="subCategoryId" required onChange={(event) => chooseSubCategory(event.target.value)}><option value="">Choose a sub-category</option>{subCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>Condition<select name="condition" required><option value="">Choose condition</option>{conditions.map((item) => <option key={item} value={item}>{item.replaceAll('_', ' ')}</option>)}</select></label>
          <label>Asking price (PKR)<input type="number" name="askingPrice" min="0.01" step="0.01" required /></label>
          <label>Description<textarea name="description" rows="3" /></label>
          <label>Fabric / material<input name="fabricMaterial" /></label><label>Brand<input name="brand" /></label>
          <label>Color<input name="color" /></label><label>Embellishment detail<input name="embellishmentDetail" /></label>
          <label>Replica disclosure<textarea name="replicaDisclosure" rows="2" /></label>
          {fields.length > 0 && <fieldset><legend>Measurements</legend>{fields.map((field) => <label key={field.id}>{field.field_name}{field.required ? ' *' : ''}{field.unit ? ` (${field.unit})` : ''}<input name={`measurement:${field.id}`} type="number" min="0" step="0.01" required={field.required} /></label>)}</fieldset>}
          <fieldset><legend>Photos</legend>{SLOT_LABELS.map(([slot, label]) => <label key={slot}>{label}<input name={`photo:${slot}`} type="file" accept="image/jpeg,image/png" required={!slot.startsWith('optional')} /></label>)}</fieldset>
          <button className="button button-primary" disabled={busy}>{busy ? 'Working…' : 'Create and submit'}</button>
        </form>
      </section>

      <section className="listing-panel"><p className="eyebrow">Seller studio</p><h2>My listings</h2>
        <button className="text-button" type="button" onClick={() => refresh().catch((cause) => setError(cause.message))}>Refresh</button>
        {listings.length === 0 ? <p>No listings yet.</p> : <ul className="workspace-list">{listings.map((item) => {
          const pending = (revisions[item.id] || []).find((revision) => revision.status === 'pending_review')
          return <li key={item.id}><strong>{item.title}</strong><span>{item.status} · PKR {item.asking_price}</span>
            <span>{item.photos?.map((photo) => `${photo.slot || 'photo'}: ${photo.processingState}`).join(' · ')}</span>
            {item.published_at && <button className="text-button" type="button" onClick={() => setSelectedListing(item.id)}>Edit published content</button>}
            {pending && <button className="text-button" type="button" disabled={busy} onClick={() => withdraw(pending.id)}>Withdraw pending revision</button>}
          </li>
        })}</ul>}
        {selectedListing && <form className="listing-form" onSubmit={createRevision}><h3>Submit a moderated revision</h3><label>New title<input name="revisionTitle" /></label><label>New price (optional)<input name="revisionPrice" type="number" min="0.01" step="0.01" /></label><label>New description<textarea name="revisionDescription" /></label><button className="button button-primary" disabled={busy}>Submit revision</button><button className="text-button" type="button" onClick={() => setSelectedListing('')}>Cancel</button></form>}
      </section>
    </WorkspaceFrame>
  )
}

function ModeratorImage({ src }) {
  const [objectUrl, setObjectUrl] = useState('')
  useEffect(() => {
    let active = true
    let createdUrl = ''
    if (src) api.getAuthenticatedImage(src).then((url) => { createdUrl = url; if (active) setObjectUrl(url); else URL.revokeObjectURL(url) }).catch(() => {})
    return () => { active = false; if (createdUrl) URL.revokeObjectURL(createdUrl) }
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
    setListings(listingQueue); setRevisions(revisionQueue)
  }
  useEffect(() => {
    let active = true
    Promise.all([api.getListingModerationQueue(), api.getListingRevisionQueue()])
      .then(([listingQueue, revisionQueue]) => {
        if (active) { setListings(listingQueue); setRevisions(revisionQueue) }
      })
      .catch((cause) => {
        if (active) setError(cause.payload?.error || cause.message)
      })
    return () => { active = false }
  }, [])

  async function run(action, done) {
    setError(''); setMessage('')
    try { await action(); setMessage(done); await refresh() }
    catch (cause) { setError(cause.payload?.error || cause.message) }
  }

  return (
    <WorkspaceFrame onSignOut={onSignOut}>
      <p className="eyebrow">Review desk</p><h1>Moderation queue</h1>
      <ErrorMessage>{error}</ErrorMessage>{message && <p role="status">{message}</p>}
      <button className="text-button" type="button" onClick={() => refresh().catch((cause) => setError(cause.message))}>Refresh queues</button>
      <section className="listing-panel"><h2>Listings and photos</h2>
        {listings.map((listing) => <article className="moderation-card" key={listing.id}><h3>{listing.title}</h3><p>PKR {listing.asking_price} · {listing.is_high_value ? 'High value' : 'Standard review'}</p>
          <div className="moderation-photos">{(listing.photos || []).map((photo) => <div key={photo.id}><ModeratorImage src={photo.imageUrl} /><strong>{photo.slot || 'unlabeled'}</strong>
            {photo.labelConfirmedAt ? <span>Confirmed</span> : <><button className="text-button" type="button" onClick={() => run(() => api.confirmListingPhoto(photo.id), 'Photo label confirmed.')}>Confirm label</button><label>Rejection reason<input value={reasons[photo.id] || ''} onChange={(event) => setReasons({ ...reasons, [photo.id]: event.target.value })} /></label><button className="text-button" type="button" disabled={!reasons[photo.id]} onClick={() => run(() => api.rejectListingPhoto(photo.id, reasons[photo.id]), 'Photo rejected with reason.')}>Reject photo</button></>}
          </div>)}</div>
          <label>Listing rejection reason<input value={reasons[listing.id] || ''} onChange={(event) => setReasons({ ...reasons, [listing.id]: event.target.value })} /></label>
          <button className="button button-primary" type="button" onClick={() => run(() => api.approveListing(listing.id), 'Listing approved.')}>Approve listing</button>
          <button className="text-button" type="button" disabled={!reasons[listing.id]} onClick={() => run(() => api.rejectListing(listing.id, reasons[listing.id]), 'Listing rejected.')}>Reject listing</button>
        </article>)}
      </section>
      <section className="listing-panel"><h2>Content revisions</h2>
        {revisions.map((revision) => <article className="moderation-card" key={revision.id}><h3>{revision.proposed_title}</h3><p>PKR {revision.proposed_asking_price} · {revision.current_title}</p>
          <button className="button button-primary" type="button" onClick={() => run(() => api.approveListingRevision(revision.id), 'Revision approved and published.')}>Approve revision</button>
          <label>Rejection reason<input value={reasons[revision.id] || ''} onChange={(event) => setReasons({ ...reasons, [revision.id]: event.target.value })} /></label>
          <button className="text-button" type="button" disabled={!reasons[revision.id]} onClick={() => run(() => api.rejectListingRevision(revision.id, reasons[revision.id]), 'Revision rejected.')}>Reject revision</button>
        </article>)}
        {revisions.length === 0 && <p>No pending revisions.</p>}
      </section>
    </WorkspaceFrame>
  )
}

export function PublicListingDetail({ id }) {
  const [listing, setListing] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => { api.getPublicListing(id).then(setListing).catch((cause) => setError(cause.payload?.error || cause.message)) }, [id])
  if (error) return <main className="account-shell"><a href="/">Poshaak</a><h1>Listing unavailable</h1><ErrorMessage>{error}</ErrorMessage></main>
  if (!listing) return <main className="account-shell"><p role="status">Loading listing…</p></main>
  return <main className="account-shell listing-workspace"><a href="/">Poshaak</a><article className="listing-panel"><h1>{listing.title}</h1><p>PKR {listing.asking_price}</p><p>{listing.description}</p><div className="moderation-photos">{(listing.images || []).map((image) => <img key={image.id} className="moderation-photo" src={image.image_url} alt={`${listing.title} listing photo`} />)}</div></article></main>
}

export default ProtectedWorkspace
