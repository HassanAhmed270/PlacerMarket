import { useEffect, useMemo, useState } from 'react'
import { BrowseState, ListingGrid } from './BrowseComponents.jsx'
import { api } from './lib/api.js'
import { buildSearchUrl } from './lib/browse.js'

const RECENT_SEARCHES_KEY = 'poshaak.recent-searches'
const FILTER_KEYS = ['mainCategoryId', 'subCategoryId', 'condition', 'minPrice', 'maxPrice', 'cityId', 'colorId', 'brandId', 'fabricId']

function readRecentSearches() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(RECENT_SEARCHES_KEY) || '[]')
    return Array.isArray(saved) ? saved.filter((item) => typeof item === 'string').slice(0, 5) : []
  } catch {
    return []
  }
}

function rememberSearch(query) {
  if (!query) return
  const recent = [query, ...readRecentSearches().filter((item) => item.toLowerCase() !== query.toLowerCase())].slice(0, 5)
  try {
    window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(recent))
  } catch {
    // Search remains usable when browser storage is disabled.
  }
}

function paramsToFilters(params) {
  return Object.fromEntries(FILTER_KEYS.map((key) => [key, params.get(key) || '']))
}

function SearchPage() {
  const initialParams = new URLSearchParams(window.location.search)
  const [query, setQuery] = useState(initialParams.get('q') || '')
  const [filters, setFilters] = useState(() => paramsToFilters(initialParams))
  const [sort, setSort] = useState(initialParams.get('sort') || '')
  const [results, setResults] = useState(null)
  const [state, setState] = useState('idle')
  const [error, setError] = useState('')
  const [catalogError, setCatalogError] = useState('')
  const [categories, setCategories] = useState([])
  const [subCategories, setSubCategories] = useState([])
  const [cities, setCities] = useState([])
  const [attributes, setAttributes] = useState({ colors: [], brands: [], fabrics: [] })
  const [vocabulary, setVocabulary] = useState(null)
  const [recentSearches, setRecentSearches] = useState(readRecentSearches)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [version, setVersion] = useState(0)
  const [cursorHistory, setCursorHistory] = useState([])

  useEffect(() => {
    let active = true
    Promise.all([
      api.getMainCategories(),
      api.getCities(),
      api.getManagedAttributes('color'),
      api.getManagedAttributes('brand'),
      api.getManagedAttributes('fabric'),
      api.getSearchVocabulary(),
    ]).then(([main, cityList, colors, brands, fabrics, words]) => {
      if (!active) return
      setCategories(main)
      setCities(cityList)
      setAttributes({ colors, brands, fabrics })
      setVocabulary(words)
    }).catch((cause) => {
      if (active) setCatalogError(cause.message)
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true
    if (!filters.mainCategoryId) {
      return () => { active = false }
    }
    api.getSubCategories(filters.mainCategoryId).then((items) => {
      if (active) setSubCategories(items)
    }).catch((cause) => {
      if (active) setCatalogError(cause.message)
    })
    return () => { active = false }
  }, [filters.mainCategoryId])

  useEffect(() => {
    let active = true
    const params = new URLSearchParams(window.location.search)
    const currentQuery = (params.get('q') || '').trim()
    const currentFilters = paramsToFilters(params)
    const currentSort = params.get('sort') || (currentQuery ? 'relevance' : 'newest')
    const request = {
      q: currentQuery,
      ...Object.fromEntries(Object.entries(currentFilters).filter(([, value]) => value)),
      sort: currentSort,
      cursor: params.get('cursor') || undefined,
    }
    if (!currentQuery && !FILTER_KEYS.some((key) => currentFilters[key])) {
      return () => { active = false }
    }
    api.searchListings(request).then((data) => {
      if (!active) return
      setResults(data)
      setState('ready')
    }).catch((cause) => {
      if (!active) return
      setError(cause.message)
      setState('error')
    })
    return () => { active = false }
  }, [version])

  useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search)
      setQuery(params.get('q') || '')
      setFilters(paramsToFilters(params))
      setSort(params.get('sort') || '')
      setSubCategories([])
      setError('')
      setState(params.get('q') || FILTER_KEYS.some((key) => params.get(key)) ? 'loading' : 'idle')
      setVersion((value) => value + 1)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const suggestions = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle || !vocabulary) return []
    const terms = [
      ...(vocabulary.categories || []).map((item) => item.name || item.value),
      ...(vocabulary.brands || []),
      ...(vocabulary.fabrics || []),
      ...(vocabulary.colors || []),
      ...(vocabulary.synonyms || []).flatMap((item) => [item.source, item.target]),
    ].filter((item) => typeof item === 'string')
    return [...new Set(terms.filter((item) => item.toLocaleLowerCase().includes(needle)))].slice(0, 6)
  }, [query, vocabulary])

  function setFilter(key, value) {
    if (key === 'mainCategoryId') setSubCategories([])
    setFilters((current) => ({ ...current, [key]: value, ...(key === 'mainCategoryId' ? { subCategoryId: '' } : {}) }))
  }

  function applySearch(nextCursor = '') {
    const normalizedQuery = query.trim()
    const nextSort = sort || (normalizedQuery ? 'relevance' : 'newest')
    const url = buildSearchUrl({ query: normalizedQuery, filters, sort: nextSort, cursor: nextCursor })
    window.history.pushState({}, '', url)
    setSort(nextSort)
    setError('')
    setState(normalizedQuery || FILTER_KEYS.some((key) => filters[key]) ? 'loading' : 'idle')
    if (!normalizedQuery && !FILTER_KEYS.some((key) => filters[key])) setResults(null)
    if (normalizedQuery) {
      rememberSearch(normalizedQuery)
      setRecentSearches(readRecentSearches())
    }
    setShowSuggestions(false)
    setVersion((value) => value + 1)
  }

  function handleSubmit(event) {
    event.preventDefault()
    setCursorHistory([])
    applySearch()
  }

  function handleNextPage() {
    if (!results?.nextCursor) return
    const currentCursor = new URLSearchParams(window.location.search).get('cursor') || ''
    setCursorHistory((history) => [...history, currentCursor])
    applySearch(results.nextCursor)
  }

  function handlePreviousPage() {
    if (!cursorHistory.length) return
    const previousCursor = cursorHistory[cursorHistory.length - 1]
    setCursorHistory((history) => history.slice(0, -1))
    applySearch(previousCursor)
  }

  function chooseSuggestion(value) {
    setQuery(value)
    rememberSearch(value)
    setRecentSearches(readRecentSearches())
    const nextSort = sort || 'relevance'
    window.history.pushState({}, '', buildSearchUrl({ query: value, filters, sort: nextSort }))
    setSort(nextSort)
    setError('')
    setState('loading')
    setShowSuggestions(false)
    setVersion((current) => current + 1)
  }

  const selectedSearch = new URLSearchParams(window.location.search)
  const hasSearch = Boolean(selectedSearch.get('q') || FILTER_KEYS.some((key) => selectedSearch.get(key)))

  return (
    <main className="category-section search-page browse-page" aria-labelledby="search-title">
      <p className="eyebrow">Poshaak marketplace</p>
      <h1 id="search-title">Find your next favorite</h1>
      <form className="search-form" onSubmit={handleSubmit}>
        <div className="search-query-wrap">
          <label htmlFor="browse-query">Search the marketplace</label>
          <input
            id="browse-query"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => window.setTimeout(() => setShowSuggestions(false), 120)}
            autoComplete="off"
            placeholder="Try silk, kurta, or a brand"
          />
          {showSuggestions && suggestions.length > 0 && (
            <ul className="search-suggestions" role="listbox" aria-label="Search suggestions">
              {suggestions.map((suggestion) => (
                <li key={suggestion}>
                  <button type="button" role="option" onMouseDown={() => chooseSuggestion(suggestion)}>{suggestion}</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="search-filter-grid">
          <label>Main category
            <select value={filters.mainCategoryId} onChange={(event) => setFilter('mainCategoryId', event.target.value)}>
              <option value="">All categories</option>
              {categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label>Sub-category / occasion
            <select value={filters.subCategoryId} onChange={(event) => setFilter('subCategoryId', event.target.value)} disabled={!filters.mainCategoryId}>
              <option value="">Any sub-category</option>
              {subCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label>Condition
            <select value={filters.condition} onChange={(event) => setFilter('condition', event.target.value)}>
              <option value="">Any condition</option>
              <option value="brand_new">Brand new</option><option value="pre_owned">Pre-owned</option>
              <option value="custom_made">Custom made</option><option value="replica">Replica</option>
            </select>
          </label>
          <label>Seller city
            <select value={filters.cityId} onChange={(event) => setFilter('cityId', event.target.value)}>
              <option value="">Any city</option>
              {cities.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label>Minimum price
            <input inputMode="numeric" type="number" min="0" value={filters.minPrice} onChange={(event) => setFilter('minPrice', event.target.value)} />
          </label>
          <label>Maximum price
            <input inputMode="numeric" type="number" min="0" value={filters.maxPrice} onChange={(event) => setFilter('maxPrice', event.target.value)} />
          </label>
          <label>Color
            <select value={filters.colorId} onChange={(event) => setFilter('colorId', event.target.value)}>
              <option value="">Any color</option>
              {attributes.colors.map((item) => <option key={item.id} value={item.id}>{item.value}</option>)}
            </select>
          </label>
          <label>Brand
            <select value={filters.brandId} onChange={(event) => setFilter('brandId', event.target.value)}>
              <option value="">Any brand</option>
              {attributes.brands.map((item) => <option key={item.id} value={item.id}>{item.value}</option>)}
            </select>
          </label>
          <label>Fabric
            <select value={filters.fabricId} onChange={(event) => setFilter('fabricId', event.target.value)}>
              <option value="">Any fabric</option>
              {attributes.fabrics.map((item) => <option key={item.id} value={item.id}>{item.value}</option>)}
            </select>
          </label>
          <label>Sort by
            <select value={sort || (query ? 'relevance' : 'newest')} onChange={(event) => setSort(event.target.value)}>
              {query && <option value="relevance">Relevance</option>}
              <option value="newest">Newest</option><option value="price-asc">Price: low to high</option>
              <option value="price-desc">Price: high to low</option>
            </select>
          </label>
        </div>
        <div className="search-actions">
          <button className="button button-secondary" type="submit">Apply search &amp; filters</button>
          <a href="/search">Clear all</a>
        </div>
      </form>
      {!query.trim() && recentSearches.length > 0 && (
        <section className="recent-searches" aria-label="Recent searches">
          <h2>Recent searches</h2>
          {recentSearches.map((item) => <button type="button" key={item} onClick={() => chooseSuggestion(item)}>{item}</button>)}
        </section>
      )}
      {catalogError && <p className="workspace-error" role="alert">{catalogError}</p>}
      {hasSearch && <section aria-label="Search results">
        <BrowseState state={state === 'idle' ? 'loading' : state} error={error} noun="listings" />
        {state === 'ready' && results?.items?.length === 0 && <p className="category-message" role="status">No matching listings were found. Try adjusting your filters.</p>}
        {state === 'ready' && results?.items?.length > 0 && <>
          <p className="results-summary">{results.items.length} listings on this page</p>
          <ListingGrid listings={results.items} />
          <div className="pagination-controls">
            <button type="button" className="button button-secondary" disabled={!cursorHistory.length} onClick={handlePreviousPage}>Previous</button>
            <button type="button" className="button button-secondary" disabled={!results.hasNextPage} onClick={handleNextPage}>Next</button>
          </div>
        </>}
      </section>}
    </main>
  )
}

export default SearchPage
