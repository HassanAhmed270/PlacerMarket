import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import { adminErrorMessage, deliveryCityActionLabel } from './lib/admin.js'

export default function AdminDeliveryCities() {
  const [cities, setCities] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pendingCityId, setPendingCityId] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    api.getAdminDeliveryCities().then((result) => {
      if (active) setCities(Array.isArray(result) ? result : [])
    }).catch((cause) => {
      if (active) setError(adminErrorMessage(cause))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [reload])

  async function toggle(city) {
    const active = !city.active
    const action = deliveryCityActionLabel(city.active).toLowerCase()
    if (!window.confirm(`${action} delivery in ${city.name}?`)) return

    setPendingCityId(city.cityId)
    setError('')
    try {
      const updated = await api.setAdminDeliveryCityActive(city.cityId, active)
      setCities((current) => current.map((item) => (
        item.cityId === updated.cityId ? { ...item, active: updated.active } : item
      )))
    } catch (cause) {
      setError(adminErrorMessage(cause))
    } finally {
      setPendingCityId('')
    }
  }

  return (
    <section>
      <div className="admin-toolbar">
        <div><p className="admin-eyebrow">Marketplace settings</p><h1>Delivery cities</h1></div>
      </div>
      {error && <><p className="admin-error" role="alert">{error}</p><button className="admin-button" type="button" onClick={() => { setLoading(true); setError(''); setReload((value) => value + 1) }}>Retry</button></>}
      {loading ? <p role="status">Loading delivery cities…</p> : error ? null : cities.length === 0
        ? <p role="status">No cities found.</p>
        : <div className="admin-list">
          {cities.map((city) => (
            <article className="admin-card admin-row" key={city.cityId}>
              <h2>{city.name}</h2>
              <p><strong>Status:</strong> {city.active ? 'Active' : 'Inactive'}</p>
              <button
                className="admin-button"
                type="button"
                aria-label={`${deliveryCityActionLabel(city.active)} ${city.name}`}
                disabled={Boolean(pendingCityId)}
                onClick={() => toggle(city)}
              >
                {pendingCityId === city.cityId ? 'Saving…' : deliveryCityActionLabel(city.active)}
              </button>
            </article>
          ))}
        </div>}
    </section>
  )
}
