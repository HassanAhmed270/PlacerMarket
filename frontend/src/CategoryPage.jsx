import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import { BrowseState, ListingGrid } from './BrowseComponents.jsx'

function CategoryPage({ mainCategoryId, subCategoryId, cityId }) {
  const [categories, setCategories] = useState([])
  const [subCategories, setSubCategories] = useState([])
  const [cities, setCities] = useState([])
  const [listings, setListings] = useState([])
  const [state, setState] = useState('loading')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    Promise.all([
      api.getMainCategories(),
      mainCategoryId ? api.getSubCategories(mainCategoryId) : Promise.resolve([]),
      api.getCities(),
    ]).then(([main, subs, cityList]) => {
      if (!active) return
      setCategories(main)
      setSubCategories(subs)
      setCities(cityList)
    }).catch((cause) => {
      if (active) {
        setError(cause.message)
        setState('error')
      }
    })
    return () => { active = false }
  }, [mainCategoryId])

  useEffect(() => {
    let active = true
    const filters = {}
    if (mainCategoryId) filters.mainCategoryId = mainCategoryId
    if (subCategoryId) filters.subCategoryId = subCategoryId
    if (cityId) filters.cityId = cityId
    api.getFilteredListings(filters).then((result) => {
      if (!active) return
      setListings(result)
      setState('ready')
    }).catch((cause) => {
      if (active) {
        setError(cause.message)
        setState('error')
      }
    })
    return () => { active = false }
  }, [mainCategoryId, subCategoryId, cityId])

  const category = categories.find((item) => item.id === mainCategoryId)
  const subCategory = subCategories.find((item) => item.id === subCategoryId)
  const city = cities.find((item) => item.id === cityId)
  const title = subCategory?.name || category?.name || 'All categories'
  const heading = cityId ? `${title} in ${city?.name || 'your selected city'}` : title

  return (
    <main className="category-section browse-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <a href="/">Home</a><span aria-hidden="true">/</span>
        {category && <><a href={`/category/${encodeURIComponent(category.id)}`}>{category.name}</a>{subCategory && <span aria-hidden="true">/</span>}</>}
        {subCategory && <span aria-current="page">{subCategory.name}</span>}
        {!category && <span aria-current="page">Categories</span>}
      </nav>
      <p className="eyebrow">Browse Poshaak</p>
      <h1>{heading}</h1>
      {!mainCategoryId && (
        <ul className="category-list browse-category-list">
          {categories.map((item) => (
            <li key={item.id}><a className="category-card" href={`/category/${encodeURIComponent(item.id)}`}>
              <span>{item.name}</span><span className="category-arrow" aria-hidden="true">↗</span>
            </a></li>
          ))}
        </ul>
      )}
      {category && !subCategoryId && (
        <nav className="subcategory-nav" aria-label="Sub-categories">
          {subCategories.map((item) => (
            <a key={item.id} href={`/category/${encodeURIComponent(category.id)}/${encodeURIComponent(item.id)}`}>{item.name}</a>
          ))}
        </nav>
      )}
      {category && <label className="category-city-filter">Shop this category by seller city
        <select value={cityId || ''} onChange={(event) => {
          const nextPath = event.target.value
            ? `/category/${encodeURIComponent(category.id)}/city/${encodeURIComponent(event.target.value)}`
            : `/category/${encodeURIComponent(category.id)}`
          window.location.assign(nextPath)
        }}>
          <option value="">All cities</option>
          {cities.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>}
      <section aria-label={`${title} listings`}>
        <BrowseState state={state} error={error} />
        {state === 'ready' && <ListingGrid listings={listings} />}
      </section>
    </main>
  )
}

export default CategoryPage
