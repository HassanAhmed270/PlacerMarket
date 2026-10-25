export function buildSearchUrl({ query = '', filters = {}, sort = '', cursor = '' } = {}) {
  const params = new URLSearchParams()
  if (query.trim()) params.set('q', query.trim())
  for (const key of [
    'mainCategoryId', 'subCategoryId', 'condition', 'minPrice', 'maxPrice',
    'cityId', 'colorId', 'brandId', 'fabricId',
  ]) {
    const value = filters[key]
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  if (sort) params.set('sort', sort)
  if (cursor) params.set('cursor', cursor)
  const queryString = params.toString()
  return `/search${queryString ? `?${queryString}` : ''}`
}

export function getLoginReturnTo(search = '') {
  const candidate = new URLSearchParams(search).get('returnTo') || ''
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) return '/account'
  return candidate
}

export function getBuyDestination({ authenticated, listingPath }) {
  if (authenticated) return { type: 'checkout' }
  const params = new URLSearchParams({ returnTo: listingPath })
  return { type: 'login', url: `/login?${params.toString()}` }
}

export function getListingViewState(statusCode, listing) {
  if (statusCode === 410 || listing?.removed) return 'gone'
  if (statusCode === 404) return 'not-found'
  if (listing?.sold || listing?.liveStatus === 'sold') return 'sold'
  if (listing?.unavailable || listing?.liveStatus === 'unavailable') return 'unavailable'
  return 'available'
}
