import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { api } from './lib/api.js'
import WorkspaceFrame, { ErrorMessage } from './WorkspaceFrame.jsx'
import { getSeoValidation } from './lib/seoValidation.js'

const ModerationWorkspace = lazy(() => import('./ModerationWorkspace.jsx'))

const SLOT_LABELS = [
  ['front', 'Front (required)'], ['back', 'Back (required)'], ['other', 'Other / detail (required)'],
  ['optional_1', 'Optional photo 1'], ['optional_2', 'Optional photo 2'], ['optional_3', 'Optional photo 3'],
]

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
  if (path === '/moderation') {
    return (
      <Suspense fallback={<WorkspaceFrame onSignOut={onSignOut}><p role="status">Loading moderation tools…</p></WorkspaceFrame>}>
        <ModerationWorkspace onSignOut={onSignOut} />
      </Suspense>
    )
  }
  return <WorkspaceFrame><h1>Workspace not found</h1><a href="/">Return to Poshaak</a></WorkspaceFrame>
}

function SellerListings({ onSignOut }) {
  const [listings, setListings] = useState([])
  const [categories, setCategories] = useState([])
  const [subCategories, setSubCategories] = useState([])
  const [conditions, setConditions] = useState([])
  const [managedAttributes, setManagedAttributes] = useState({ color: [], fabric: [], brand: [] })
  const [fields, setFields] = useState([])
  const [revisions, setRevisions] = useState({})
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [uploadState, setUploadState] = useState('')
  const [selectedListing, setSelectedListing] = useState('')
  const [seoPreview, setSeoPreview] = useState(null)
  const [seoChoice, setSeoChoice] = useState('recommended')
  const [seoValidation, setSeoValidation] = useState([])
  const [seoTitleValue, setSeoTitleValue] = useState('')
  const [seoDescriptionValue, setSeoDescriptionValue] = useState('')
  const [revisionSeoChoice, setRevisionSeoChoice] = useState('recommended')
  const [revisionSeoTitleValue, setRevisionSeoTitleValue] = useState('')
  const [revisionSeoDescriptionValue, setRevisionSeoDescriptionValue] = useState('')
  const [revisionSeoPreview, setRevisionSeoPreview] = useState(null)
  const [revisionSeoIssues, setRevisionSeoIssues] = useState([])
  const [attributeChoices, setAttributeChoices] = useState({})
  const seoPreviewRequest = useRef(0)

  async function refresh() {
    const result = await api.getMyListings()
    setListings(result)
    const history = await Promise.all(result.filter((item) => item.published_at).map(async (item) => [item.id, await api.getListingRevisions(item.id)]))
    setRevisions(Object.fromEntries(history))
  }

  useEffect(() => {
    let active = true
    Promise.all([
      api.getMainCategories(), api.getConditionTypes(), api.getMyListings(),
      api.getManagedAttributes('color'), api.getManagedAttributes('fabric'), api.getManagedAttributes('brand'),
    ])
      .then(async ([main, conditionList, own, colors, fabrics, brands]) => {
        if (!active) return
        setCategories(main)
        setConditions(conditionList)
        setManagedAttributes({ color: colors, fabric: fabrics, brand: brands })
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
    const form = new FormData(formElement)
    const selectedSeoChoice = form.get('seoChoice') || 'recommended'
    const seoIssues = selectedSeoChoice === 'custom' ? getSeoValidation({
      title: String(form.get('seoTitle') || ''),
      description: String(form.get('seoDescription') || ''),
      condition: String(form.get('condition') || ''),
      required: true,
    }) : []
    setSeoValidation(seoIssues)
    if (seoIssues.length) return
    setBusy(true); setError(''); setMessage('')
    const measurements = fields.flatMap((field) => {
      const value = String(form.get(`measurement:${field.id}`) || '').trim()
      return value ? [{ fieldDefId: field.id, value: Number(value) }] : []
    })
    function managedValue(type, idField, valueField) {
      const selected = String(form.get(`${type}Choice`) || '')
      if (selected === 'custom') {
        const custom = String(form.get(`${type}Custom`) || '').trim()
        return custom ? { [valueField]: custom } : {}
      }
      return selected ? { [idField]: selected } : {}
    }
    const input = {
      title: form.get('title'), mainCategoryId: form.get('mainCategoryId'), subCategoryId: form.get('subCategoryId'),
      condition: form.get('condition'), askingPrice: Number(form.get('askingPrice')),
      description: form.get('description') || undefined,
      replicaDisclosure: form.get('replicaDisclosure') || undefined,
      ...managedValue('fabric', 'fabricId', 'fabricMaterial'),
      ...managedValue('brand', 'brandId', 'brand'),
      ...managedValue('color', 'colorId', 'color'),
      embellishmentDetail: form.get('embellishmentDetail') || undefined,
      seoChoice: selectedSeoChoice,
      ...(selectedSeoChoice === 'custom' ? {
        seoTitle: form.get('seoTitle'),
        seoDescription: form.get('seoDescription'),
      } : {}),
      measurements,
    }
    try {
      const listing = await api.createListing(input)
      setSeoPreview(listing.seo)
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
      setAttributeChoices({})
      setSeoChoice('recommended')
      setSeoValidation([])
      setSeoTitleValue('')
      setSeoDescriptionValue('')
      setUploadState('')
      setMessage('Listing submitted to the moderation queue.')
      await refresh()
    } catch (cause) {
      setError(cause.payload?.error || cause.message || 'The listing could not be submitted.')
    } finally { setBusy(false); setUploadState('') }
  }

  async function previewSeo(formElement) {
    const requestId = ++seoPreviewRequest.current
    const form = new FormData(formElement)
    function selectedAttribute(type) {
      const selected = String(form.get(`${type}Choice`) || '')
      if (selected === 'custom') return String(form.get(`${type}Custom`) || '').trim() || undefined
      return managedAttributes[type].find((item) => item.id === selected)?.value
    }
    const details = {
      condition: form.get('condition'),
      subCategoryId: form.get('subCategoryId'),
      color: selectedAttribute('color'),
      fabricMaterial: selectedAttribute('fabric'),
      brand: selectedAttribute('brand'),
    }
    setError('')
    try {
      const result = await api.getSeoRecommendation(details)
      if (requestId === seoPreviewRequest.current) setSeoPreview(result)
    } catch (cause) {
      if (requestId === seoPreviewRequest.current) setError(cause.payload?.error || cause.message)
    }
  }

  function updateSeoValidation(event) {
    const form = new FormData(event.currentTarget)
    const selected = String(form.get('seoChoice') || 'recommended')
    setSeoChoice(selected)
    setSeoTitleValue(String(form.get('seoTitle') || ''))
    setSeoDescriptionValue(String(form.get('seoDescription') || ''))
    setSeoValidation(selected === 'custom' ? getSeoValidation({
      title: String(form.get('seoTitle') || ''),
      description: String(form.get('seoDescription') || ''),
      condition: String(form.get('condition') || ''),
      required: true,
    }) : [])
  }

  async function createRevision(event) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const selected = listings.find((item) => item.id === selectedListing)
    const seoChoice = form.get('revisionSeoChoice') || 'recommended'
    const issues = seoChoice === 'custom' ? getSeoValidation({
      title: String(form.get('revisionSeoTitle') || ''),
      description: String(form.get('revisionSeoDescription') || ''),
      condition: String(selected?.condition || ''),
      required: true,
    }) : []
    setRevisionSeoIssues(issues)
    if (issues.length) return
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await api.submitListingRevision(selectedListing, {
        title: form.get('revisionTitle') || undefined,
        description: form.get('revisionDescription') || undefined,
        askingPrice: form.get('revisionPrice') ? Number(form.get('revisionPrice')) : undefined,
        seoChoice,
        ...(seoChoice === 'custom' ? {
          seoTitle: form.get('revisionSeoTitle'),
          seoDescription: form.get('revisionSeoDescription'),
        } : {}),
      })
      setMessage(`Revision ${result.id} is awaiting moderation.`)
      formElement.reset()
      await refresh()
    } catch (cause) { setError(cause.payload?.error || cause.message) }
    finally { setBusy(false) }
  }

  function updateRevisionSeoValidation(event) {
    const form = new FormData(event.currentTarget)
    const selectedChoice = String(form.get('revisionSeoChoice') || 'recommended')
    setRevisionSeoChoice(selectedChoice)
    setRevisionSeoTitleValue(String(form.get('revisionSeoTitle') || ''))
    setRevisionSeoDescriptionValue(String(form.get('revisionSeoDescription') || ''))
    const selected = listings.find((item) => item.id === selectedListing)
    setRevisionSeoIssues(selectedChoice === 'custom' ? getSeoValidation({
      title: String(form.get('revisionSeoTitle') || ''),
      description: String(form.get('revisionSeoDescription') || ''),
      condition: String(selected?.condition || ''),
      required: true,
    }) : [])
  }

  async function previewRevisionSeo() {
    const selected = listings.find((item) => item.id === selectedListing)
    if (!selected) return
    setError('')
    try {
      setRevisionSeoPreview(await api.getSeoRecommendation({
        condition: selected.condition,
        subCategoryId: selected.sub_category_id,
        color: selected.color || undefined,
        fabricMaterial: selected.fabric_material || undefined,
        brand: selected.brand || undefined,
      }))
    } catch (cause) {
      setError(cause.payload?.error || cause.message)
    }
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
        <form className="listing-form" onSubmit={createAndSubmit} onChange={updateSeoValidation}>
          <label>Title<input name="title" required maxLength="150" /></label>
          <label>Main category<select name="mainCategoryId" required onChange={(event) => chooseMainCategory(event.target.value)}><option value="">Choose a category</option>{categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>Sub-category<select name="subCategoryId" required onChange={(event) => chooseSubCategory(event.target.value)}><option value="">Choose a sub-category</option>{subCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>Condition<select name="condition" required><option value="">Choose condition</option>{conditions.map((item) => <option key={item} value={item}>{item.replaceAll('_', ' ')}</option>)}</select></label>
          <label>Price (PKR)<input type="number" name="askingPrice" min="0.01" step="0.01" required /></label>
          <label>Description<textarea name="description" rows="3" /></label>
          {[
            ['color', 'Color'],
            ['brand', 'Brand'],
            ['fabric', 'Fabric / material'],
          ].map(([type, label]) => (
            <div className="managed-attribute-field" key={type}>
              <label>{label}<select name={`${type}Choice`} value={attributeChoices[type] || ''} onChange={(event) => setAttributeChoices((current) => ({ ...current, [type]: event.target.value }))}><option value="">Choose {label.toLowerCase()}</option>{managedAttributes[type].map((item) => <option key={item.id} value={item.id}>{item.value}</option>)}<option value="custom">Enter a custom value</option></select></label>
              {attributeChoices[type] === 'custom' && <>
                <label className="custom-attribute-input">Custom {label.toLowerCase()}<input name={`${type}Custom`} maxLength={type === 'color' ? 50 : 100} required /></label>
                <p className="form-hint">This custom value will be shown as pending approval and join catalog filters only after approval.</p>
              </>}
            </div>
          ))}
          <label>Embellishment detail<input name="embellishmentDetail" /></label>
          <label>Replica disclosure<textarea name="replicaDisclosure" rows="2" /></label>
          <fieldset><legend>Search title and description</legend>
            <p>The recommendation is built from your seller details (condition, sub-category, color, fabric, brand, and seller city). You can use it or write your own text for moderation.</p>
            <button className="text-button" type="button" onClick={(event) => previewSeo(event.currentTarget.form)}>Preview recommendation</button>
            {seoPreview && <div className="seo-recommendation" role="status"><strong>Recommendation built from your seller details</strong><p>{seoPreview.recommendation.title}</p><p>{seoPreview.recommendation.description}</p><small>{seoPreview.note}</small></div>}
            <label><input type="radio" name="seoChoice" value="recommended" checked={seoChoice === 'recommended'} onChange={() => { setSeoChoice('recommended'); setSeoValidation([]) }} /> Use recommendation</label>
            <label><input type="radio" name="seoChoice" value="custom" checked={seoChoice === 'custom'} onChange={() => setSeoChoice('custom')} /> Write my own text</label>
            {seoChoice === 'custom' && <>
              <label>My SEO title<input name="seoTitle" value={seoTitleValue} onChange={(event) => setSeoTitleValue(event.target.value)} maxLength="60" aria-describedby="seo-title-count" /><small id="seo-title-count">{seoTitleValue.length}/60 characters.</small></label>
              <label>My SEO description<textarea name="seoDescription" value={seoDescriptionValue} onChange={(event) => setSeoDescriptionValue(event.target.value)} maxLength="155" rows="2" aria-describedby="seo-description-count" /><small id="seo-description-count">{seoDescriptionValue.length}/155 characters. Do not include a price.</small></label>
              {seoValidation.length > 0 && <ul className="seo-validation" role="alert">{seoValidation.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
            </>}
          </fieldset>
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
            {item.published_at && <button className="text-button" type="button" onClick={() => {
              setSelectedListing(item.id)
              setRevisionSeoChoice(item.seo_choice || 'recommended')
              setRevisionSeoTitleValue(item.seo_title || '')
              setRevisionSeoDescriptionValue(item.seo_description || '')
              setRevisionSeoIssues([])
            }}>Edit published content</button>}
            {pending && <button className="text-button" type="button" disabled={busy} onClick={() => withdraw(pending.id)}>Withdraw pending revision</button>}
          </li>
        })}</ul>}
        {selectedListing && (() => {
          return <form className="listing-form" onSubmit={createRevision} onChange={updateRevisionSeoValidation}><h3>Change listing details</h3><label>New title<input name="revisionTitle" /></label><label>New price (optional)<input name="revisionPrice" type="number" min="0.01" step="0.01" /></label><label>New description<textarea name="revisionDescription" /></label>
            <fieldset><legend>Search title and description</legend>
              <p>The recommendation is based on the listing's structured details and seller city. SEO changes are reviewed with the rest of the revision.</p>
              <button className="text-button" type="button" onClick={previewRevisionSeo}>Preview recommendation</button>
              {revisionSeoPreview && <div className="seo-recommendation" role="status"><strong>Recommendation built from your seller details</strong><p>{revisionSeoPreview.recommendation.title}</p><p>{revisionSeoPreview.recommendation.description}</p><small>{revisionSeoPreview.note}</small></div>}
              <label><input type="radio" name="revisionSeoChoice" value="recommended" checked={revisionSeoChoice === 'recommended'} onChange={() => { setRevisionSeoChoice('recommended'); setRevisionSeoIssues([]) }} /> Use recommendation</label>
              <label><input type="radio" name="revisionSeoChoice" value="custom" checked={revisionSeoChoice === 'custom'} onChange={() => setRevisionSeoChoice('custom')} /> Write my own text</label>
              {revisionSeoChoice === 'custom' && <>
                <label>My SEO title<input name="revisionSeoTitle" value={revisionSeoTitleValue} onChange={(event) => setRevisionSeoTitleValue(event.target.value)} maxLength="60" /><small>{revisionSeoTitleValue.length}/60 characters.</small></label>
                <label>My SEO description<textarea name="revisionSeoDescription" value={revisionSeoDescriptionValue} onChange={(event) => setRevisionSeoDescriptionValue(event.target.value)} maxLength="155" rows="2" /><small>{revisionSeoDescriptionValue.length}/155 characters. Do not include a price.</small></label>
                {revisionSeoIssues.length > 0 && <ul className="seo-validation" role="alert">{revisionSeoIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
              </>}
            </fieldset>
            <button className="button button-primary" disabled={busy}>Submit change</button><button className="text-button" type="button" onClick={() => setSelectedListing('')}>Cancel</button></form>
        })()}
      </section>
    </WorkspaceFrame>
  )
}

export default ProtectedWorkspace
