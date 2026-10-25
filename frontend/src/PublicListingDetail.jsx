import { useEffect, useState } from 'react'
import { ListingGrid } from './BrowseComponents.jsx'
import { api } from './lib/api.js'
import { getBuyDestination, getListingViewState } from './lib/browse.js'
import { POLL_INTERVALS, schedulePolling } from './lib/polling.js'
import { getMessageErrorMessage } from './lib/seoValidation.js'

function PublicListingDetail({ id }) {
  const [listing, setListing] = useState(null)
  const [error, setError] = useState('')
  const [statusCode, setStatusCode] = useState(0)
  const [selectedImage, setSelectedImage] = useState(0)
  const [actionMessage, setActionMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const [isFavorite, setIsFavorite] = useState(false)
  const [conversationId, setConversationId] = useState('')
  const [messages, setMessages] = useState([])
  const [messageText, setMessageText] = useState('')
  const [messageState, setMessageState] = useState('idle')
  const [messageError, setMessageError] = useState('')

  useEffect(() => {
    if (!conversationId) return undefined
    let active = true
    async function refreshMessages() {
      try {
        const result = await api.getConversationMessages(conversationId)
        await api.markConversationRead(conversationId)
        if (active) setMessages(result.messages || [])
      } catch (cause) {
        if (active) setMessageError(cause.payload?.error || cause.message)
      }
    }
    const stopChatPolling = schedulePolling(refreshMessages, POLL_INTERVALS.openChat)
    const stopInboxPolling = schedulePolling(
      () => api.getConversationInbox().catch((cause) => { if (active) setMessageError(cause.payload?.error || cause.message) }),
      POLL_INTERVALS.unread,
    )
    return () => {
      active = false
      stopChatPolling()
      stopInboxPolling()
    }
  }, [conversationId])

  useEffect(() => {
    let active = true
    const originalTitle = document.title
    const description = document.querySelector('meta[name="description"]')
    const originalDescription = description?.getAttribute('content')
    const canonical = document.querySelector('link[rel="canonical"]')
    const originalCanonical = canonical?.getAttribute('href')
    const robots = document.querySelector('meta[name="robots"]')
    const originalRobots = robots?.getAttribute('content')
    const meta = description || document.createElement('meta')
    const link = canonical || document.createElement('link')
    const robotsMeta = robots || document.createElement('meta')
    if (!description) {
      meta.name = 'description'
      document.head.append(meta)
    }
    if (!canonical) {
      link.rel = 'canonical'
      document.head.append(link)
    }
    if (!robots) {
      robotsMeta.name = 'robots'
      document.head.append(robotsMeta)
    }
    api.getPublicListing(id).then((result) => {
      if (!active) return
      const canonicalPath = `/listing/${result.canonicalKey}`
      if (window.location.pathname !== canonicalPath) window.history.replaceState({}, '', canonicalPath)
      document.title = result.seo.choice.title
      meta.content = result.seo.choice.description
      link.href = new URL(result.canonicalUrl, window.location.origin).href
      robotsMeta.content = result.sold || result.unavailable ? 'noindex,follow' : 'index,follow'
      setListing(result)
    }).catch((cause) => {
      if (active) {
        setStatusCode(cause.status || 0)
        if (cause.status === 410) robotsMeta.content = 'noindex,follow'
        setError(cause.message)
      }
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
      if (robots) {
        if (originalRobots === null) robots.removeAttribute('content')
        else robots.content = originalRobots
      } else {
        robotsMeta.remove()
      }
    }
  }, [id])

  function navigate(path) {
    window.history.pushState({}, '', path)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  function listingPath() {
    return window.location.pathname
  }

  async function ensureAuthentication() {
    if (api.isAuthenticated()) return true
    try {
      const result = await api.refresh()
      api.setAccessToken(result.accessToken)
      return true
    } catch (cause) {
      if (cause.status === 401 || cause.status === 403) {
        const destination = getBuyDestination({ authenticated: false, listingPath: listingPath() })
        window.location.assign(destination.url)
        return false
      }
      throw cause
    }
  }

  async function handleBuy() {
    setActionError('')
    setActionMessage('')
    try {
      if (api.isAuthenticated()) {
        navigate(`/checkout/soon?listing=${encodeURIComponent(listingPath())}`)
        return
      }
      const result = await api.refresh()
      api.setAccessToken(result.accessToken)
      navigate(`/checkout/soon?listing=${encodeURIComponent(listingPath())}`)
    } catch (cause) {
      if (cause.status === 401 || cause.status === 403) {
        const destination = getBuyDestination({ authenticated: false, listingPath: listingPath() })
        window.location.assign(destination.url)
      } else {
        setActionError(cause.message)
      }
    }
  }

  async function toggleFavorite() {
    setActionError('')
    setActionMessage('')
    try {
      if (!await ensureAuthentication()) return
      if (isFavorite) {
        await api.removeFavorite(listing.id)
        setIsFavorite(false)
        setActionMessage('Removed from your favorites.')
      } else {
        await api.addFavorite(listing.id)
        setIsFavorite(true)
        setActionMessage('Added to your favorites.')
      }
    } catch (cause) {
      setActionError(cause.message)
    }
  }

  async function shareListing() {
    setActionError('')
    setActionMessage('')
    try {
      const { url } = await api.getShareUrl(listing.id)
      if (navigator.share) {
        await navigator.share({ title: listing.title, url })
        setActionMessage('Listing shared.')
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
        setActionMessage('Listing link copied.')
      } else {
        setActionMessage(`Share this listing: ${url}`)
      }
    } catch (cause) {
      if (cause.name !== 'AbortError') setActionError(cause.message)
    }
  }

  async function openMessages() {
    setActionError('')
    setMessageError('')
    setMessageState('loading')
    try {
      if (!await ensureAuthentication()) {
        setMessageState('idle')
        return
      }
      const conversation = await api.startConversation(listing.id)
      setConversationId(conversation.id)
      const result = await api.getConversationMessages(conversation.id)
      await api.markConversationRead(conversation.id)
      setMessages(result.messages || [])
      setMessageState('ready')
    } catch (cause) {
      setMessageError(cause.message)
      setMessageState('error')
    }
  }

  async function sendMessage(event) {
    event.preventDefault()
    if (!messageText.trim() || !conversationId) return
    setMessageError('')
    try {
      const message = await api.sendConversationMessage(conversationId, messageText)
      setMessages((current) => [message, ...current])
      setMessageText('')
    } catch (cause) {
      setMessageError(getMessageErrorMessage(cause))
    }
  }

  if (error) {
    const state = getListingViewState(statusCode, null)
    if (state === 'gone') return <main className="unavailable-page" data-status="410"><p className="eyebrow">410 · Gone</p><h1>Listing no longer available</h1><p>This item was removed and is no longer available to browse.</p><a href="/search">Browse other listings</a></main>
    return <main className="unavailable-page" data-status={statusCode}><p className="eyebrow">Listing unavailable</p><h1>We couldn't find this listing</h1><p role="alert">{error}</p><a href="/search">Browse listings</a></main>
  }
  if (!listing) return <main className="account-shell"><p role="status">Loading listing…</p></main>

  const viewState = getListingViewState(200, listing)
  if (viewState === 'unavailable') {
    return <main className="unavailable-page" data-status="200"><p className="eyebrow">Temporarily unavailable</p><h1>This listing is taking a pause</h1><p>The seller has temporarily paused this item. Please check back later.</p><a href="/search">Browse other listings</a></main>
  }
  const images = listing.images || []
  const image = images[selectedImage]
  const canBuy = viewState === 'available' && !listing.reserved
  const canMessage = viewState === 'available'

  return (
    <main className="listing-detail-page">
      {viewState === 'sold' && <div className="sold-banner" role="status"><strong>Sold</strong><span>This piece has found a new home.</span></div>}
      {listing.reserved && <div className="reserved-banner" role="status">Reserved while a buyer completes checkout.</div>}
      <nav className="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a><span aria-hidden="true">/</span><a href="/categories">Browse</a><span aria-hidden="true">/</span><span aria-current="page">{listing.title}</span></nav>
      <div className="listing-detail-grid">
        <section className="listing-gallery" aria-label="Listing images">
          {image ? <img className="listing-hero-image" src={image.image_url} alt={`${listing.title}, view ${selectedImage + 1}`} /> : <div className="listing-image-placeholder" role="img" aria-label="No listing image available">Poshaak</div>}
          {images.length > 1 && <div className="listing-thumbnails" aria-label="Choose image">
            {images.map((item, index) => <button type="button" key={item.id} className={selectedImage === index ? 'selected' : ''} aria-label={`Show image ${index + 1}`} aria-pressed={selectedImage === index} onClick={() => setSelectedImage(index)}>
              <img src={item.image_url} alt="" />
            </button>)}
          </div>}
        </section>
        <article className="listing-detail-copy">
          <p className="eyebrow">Poshaak marketplace</p>
          <h1>{listing.title}</h1>
          <p className="listing-price">PKR {listing.asking_price}</p>
          <p className="listing-status">{listing.reserved ? 'Reserved' : viewState === 'sold' ? 'Sold' : 'Published'}</p>
          <p className="listing-description">{listing.description}</p>
          <dl className="listing-facts">
            {listing.condition && <><dt>Condition</dt><dd>{listing.condition.replaceAll('_', ' ')}</dd></>}
            {listing.color && <><dt>Color</dt><dd>{listing.color}</dd></>}
            {listing.brand && <><dt>Brand</dt><dd>{listing.brand}</dd></>}
            {listing.fabric_material && <><dt>Fabric</dt><dd>{listing.fabric_material}</dd></>}
          </dl>
          <div className="listing-actions">
            {canBuy && <button className="button button-buy" type="button" onClick={handleBuy}>Buy</button>}
            {!canBuy && viewState === 'sold' && <span className="sold-action">This listing is sold</span>}
            {!canBuy && listing.reserved && <span className="sold-action">This listing is reserved</span>}
            <button className="button button-secondary" type="button" onClick={toggleFavorite}>{isFavorite ? '♥ Saved' : '♡ Favorite'}</button>
            <button className="button button-secondary" type="button" onClick={shareListing}>Share</button>
            {canMessage && <button className="button button-secondary" type="button" onClick={openMessages}>Message seller</button>}
          </div>
          {actionMessage && <p className="action-message" role="status">{actionMessage}</p>}
          {actionError && <p className="workspace-error" role="alert">{actionError}</p>}
          {conversationId && <section className="message-panel" aria-label="Message seller">
            <h2>Message the seller</h2>
            {messageState === 'loading' && <p role="status">Opening conversation…</p>}
            {messageState === 'error' && <p className="workspace-error" role="alert">{messageError}</p>}
            {messageState === 'ready' && <>
              <ol className="message-list">{[...messages].reverse().map((message) => <li key={message.id}>{message.body}</li>)}</ol>
              {messageError && <p className="workspace-error" role="alert">{messageError}</p>}
              <form onSubmit={sendMessage}>
                <label htmlFor="seller-message">Your message</label>
                <textarea id="seller-message" value={messageText} onChange={(event) => setMessageText(event.target.value)} maxLength="1000" required />
                <button className="button button-secondary" type="submit">Send message</button>
              </form>
            </>}
          </section>}
        </article>
      </div>
      {listing.seller && <aside className="seller-card">
        <p className="eyebrow">Seller</p><h2>Meet the seller</h2>
        {listing.seller.averageRating != null && <p>{Number(listing.seller.averageRating).toFixed(1)} rating · {listing.seller.ratingCount} reviews</p>}
        {listing.seller.joinDate && <p>On Poshaak since {new Date(listing.seller.joinDate).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })}</p>}
      </aside>}
      {viewState === 'sold' && listing.similarItems?.length > 0 && <section className="similar-listings" aria-labelledby="similar-title">
        <p className="eyebrow">More to discover</p><h2 id="similar-title">Similar pieces</h2>
        <ListingGrid listings={listing.similarItems} />
      </section>}
    </main>
  )
}

export default PublicListingDetail
