import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import { getBuyDestination } from './lib/browse.js'
import { getCheckoutError, validateCheckoutAddress } from './lib/checkout.js'

function navigate(path) {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function CheckoutPage({ listingId }) {
  const [values, setValues] = useState({
    recipientName: '',
    phone: '',
    cityId: '',
    addressLine1: '',
    addressLine2: '',
    postalCode: '',
  })
  const [cities, setCities] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState({})
  const [error, setError] = useState('')
  const [retryable, setRetryable] = useState(false)

  useEffect(() => {
    let active = true
    async function prepareCheckout() {
      try {
        if (!api.isAuthenticated()) {
          const session = await api.refresh()
          api.setAccessToken(session.accessToken)
        }
        const result = await api.getDeliveryCities()
        if (active) setCities(result)
      } catch (cause) {
        if (!active) return
        if (cause.status === 401 || cause.status === 403) {
          const listingPath = `/listing/${encodeURIComponent(listingId)}`
          const destination = getBuyDestination({ authenticated: false, listingPath })
          window.location.replace(destination.url)
          return
        }
        setError(getCheckoutError(cause).message)
      } finally {
        if (active) setLoading(false)
      }
    }
    prepareCheckout()
    return () => { active = false }
  }, [listingId])

  function updateField(event) {
    const { name, value } = event.currentTarget
    setValues((current) => ({ ...current, [name]: value }))
    setErrors((current) => ({ ...current, [name]: '' }))
    setError('')
    setRetryable(false)
  }

  async function retryLoadingCities() {
    setLoading(true)
    setError('')
    try {
      setCities(await api.getDeliveryCities())
    } catch (cause) {
      setError(getCheckoutError(cause).message)
    } finally {
      setLoading(false)
    }
  }

  async function submit(event) {
    event.preventDefault()
    setError('')
    setRetryable(false)
    const validation = validateCheckoutAddress(values)
    setErrors(validation.errors)
    if (!validation.valid) return

    setBusy(true)
    try {
      const reservation = await api.buyListing(listingId, { address: validation.address })
      navigate(`/orders/${encodeURIComponent(reservation.orderId)}`)
    } catch (cause) {
      const mapped = getCheckoutError(cause)
      if (cause.status === 401 || cause.status === 403) {
        const listingPath = `/listing/${encodeURIComponent(listingId)}`
        const destination = getBuyDestination({ authenticated: false, listingPath })
        window.location.replace(destination.url)
        return
      }
      if (mapped.type === 'payments-disabled') {
        const listingPath = `/listing/${encodeURIComponent(listingId)}`
        navigate(`/checkout/soon?listing=${encodeURIComponent(listingPath)}`)
        return
      }
      if (cause.status === 409) {
        try {
          const orders = await api.getMyOrders({ limit: 20 })
          const existing = orders.find((order) => (
            order.listingId === listingId
            && (order.status === 'funded'
              || (['reserved', 'payment_pending'].includes(order.status)
                && Date.parse(order.reservationExpiresAt) > Date.now()))
          ))
          if (existing) {
            navigate(`/orders/${encodeURIComponent(existing.orderId)}`)
            return
          }
        } catch (lookupError) {
          const lookupErrorState = getCheckoutError(lookupError)
          setError(lookupErrorState.message)
          setRetryable(['retry', 'network'].includes(lookupErrorState.type))
          return
        }
      }
      setError(mapped.message)
      setRetryable(['retry', 'network'].includes(mapped.type))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <main className="route-loading" role="status">Preparing checkout…</main>

  return (
    <main className="checkout-page">
      <section className="checkout-panel" aria-labelledby="checkout-title">
        <p className="eyebrow">Secure checkout</p>
        <h1 id="checkout-title">Delivery address</h1>
        <p className="checkout-intro">Enter the address for this order. The server confirms availability and calculates the amount after you continue.</p>
        {error && <p className="checkout-error" role="alert">{error}</p>}
        {!cities.length && !error && <p className="checkout-error" role="alert">No supported delivery cities are available right now.</p>}
        {!cities.length && error && <button className="button button-secondary" type="button" onClick={retryLoadingCities} disabled={loading}>Retry loading cities</button>}
        <form onSubmit={submit} noValidate>
          <label htmlFor="checkout-recipient">Recipient name</label>
          <input
            id="checkout-recipient"
            name="recipientName"
            autoComplete="name"
            maxLength="100"
            required
            value={values.recipientName}
            aria-invalid={Boolean(errors.recipientName)}
            aria-describedby={errors.recipientName ? 'checkout-recipient-error' : undefined}
            onChange={updateField}
          />
          {errors.recipientName && <span id="checkout-recipient-error" className="field-error">{errors.recipientName}</span>}

          <label htmlFor="checkout-phone">Phone</label>
          <input
            id="checkout-phone"
            name="phone"
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            maxLength="21"
            pattern="\+?[1-9]\d{7,19}"
            required
            value={values.phone}
            aria-invalid={Boolean(errors.phone)}
            aria-describedby={errors.phone ? 'checkout-phone-error' : undefined}
            onChange={updateField}
          />
          {errors.phone && <span id="checkout-phone-error" className="field-error">{errors.phone}</span>}

          <label htmlFor="checkout-city">Delivery city</label>
          <select
            id="checkout-city"
            name="cityId"
            required
            value={values.cityId}
            aria-invalid={Boolean(errors.cityId)}
            aria-describedby={errors.cityId ? 'checkout-city-error' : undefined}
            onChange={updateField}
          >
            <option value="">Choose a supported city</option>
            {cities.map((city) => <option key={city.id} value={city.id}>{city.name}</option>)}
          </select>
          {errors.cityId && <span id="checkout-city-error" className="field-error">{errors.cityId}</span>}

          <label htmlFor="checkout-address-line1">Address line 1</label>
          <input
            id="checkout-address-line1"
            name="addressLine1"
            autoComplete="address-line1"
            maxLength="200"
            required
            value={values.addressLine1}
            aria-invalid={Boolean(errors.addressLine1)}
            aria-describedby={errors.addressLine1 ? 'checkout-address-line1-error' : undefined}
            onChange={updateField}
          />
          {errors.addressLine1 && <span id="checkout-address-line1-error" className="field-error">{errors.addressLine1}</span>}

          <label htmlFor="checkout-address-line2">Address line 2 (optional)</label>
          <input
            id="checkout-address-line2"
            name="addressLine2"
            autoComplete="address-line2"
            maxLength="200"
            value={values.addressLine2}
            aria-invalid={Boolean(errors.addressLine2)}
            aria-describedby={errors.addressLine2 ? 'checkout-address-line2-error' : undefined}
            onChange={updateField}
          />
          {errors.addressLine2 && <span id="checkout-address-line2-error" className="field-error">{errors.addressLine2}</span>}

          <label htmlFor="checkout-postal-code">Postal code (optional)</label>
          <input
            id="checkout-postal-code"
            name="postalCode"
            autoComplete="postal-code"
            maxLength="20"
            value={values.postalCode}
            aria-invalid={Boolean(errors.postalCode)}
            aria-describedby={errors.postalCode ? 'checkout-postal-code-error' : undefined}
            onChange={updateField}
          />
          {errors.postalCode && <span id="checkout-postal-code-error" className="field-error">{errors.postalCode}</span>}

          <button className="button button-primary" type="submit" disabled={busy || !cities.length}>
            {busy ? 'Reserving…' : retryable ? 'Retry reservation' : 'Reserve and review amount'}
          </button>
        </form>
        <a className="checkout-back-link" href={`/listing/${encodeURIComponent(listingId)}`}>Return to listing</a>
      </section>
    </main>
  )
}

export default CheckoutPage
