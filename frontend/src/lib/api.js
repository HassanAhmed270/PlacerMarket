const DEFAULT_API_BASE_URL = 'http://localhost:3000/api'
export const DEV_FAKES_BANNER = Boolean(import.meta.env?.DEV && import.meta.env?.VITE_DEV_FAKES === '1')
let accessTokenInMemory = null

export class ApiError extends Error {
  constructor(status) {
    super(`The API request failed with status ${status}.`)
    this.name = 'ApiError'
    this.status = status
  }
}

export function createApiClient({
  baseUrl = import.meta.env?.VITE_API_BASE_URL || DEFAULT_API_BASE_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '')

  async function get(path, { signal, authenticated = false } = {}) {
    const response = await fetchImpl(`${normalizedBaseUrl}/${path.replace(/^\/+/, '')}`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...(authenticated && accessTokenInMemory ? { Authorization: `Bearer ${accessTokenInMemory}` } : {}) },
      signal,
    })

    if (!response.ok) throw new ApiError(response.status)
    if (response.status === 204) return null

    try {
      return await response.json()
    } catch {
      throw new ApiError(response.status)
    }
  }

  async function send(method, path, body, { authenticated = false, refresh = false } = {}) {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' }
    if (authenticated && accessTokenInMemory) headers.Authorization = `Bearer ${accessTokenInMemory}`
    const response = await fetchImpl(`${normalizedBaseUrl}/${path.replace(/^\/+/, '')}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(refresh ? { credentials: 'include' } : {}),
    })
    let result = null
    try { result = await response.json() } catch { /* Empty success response. */ }
    if (!response.ok) throw Object.assign(new ApiError(response.status), { payload: result })
    return result
  }

  const post = (path, body, options) => send('POST', path, body, options)

  async function upload(path, file) {
    const response = await fetchImpl(`${normalizedBaseUrl}/${path.replace(/^\/+/, '')}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json', 'Content-Type': 'application/octet-stream',
        ...(accessTokenInMemory ? { Authorization: `Bearer ${accessTokenInMemory}` } : {}),
      },
      body: file,
    })
    let result = null
    try { result = await response.json() } catch { /* Non-JSON response. */ }
    if (!response.ok) throw Object.assign(new ApiError(response.status), { payload: result })
    return result
  }

  async function getAuthenticatedImage(path) {
    const imageUrl = path.startsWith('/api/')
      ? `${new URL(normalizedBaseUrl).origin}${path}`
      : `${normalizedBaseUrl}/${path.replace(/^\/+/, '')}`
    const response = await fetchImpl(imageUrl, {
      method: 'GET', headers: { ...(accessTokenInMemory ? { Authorization: `Bearer ${accessTokenInMemory}` } : {}) },
    })
    if (!response.ok) throw new ApiError(response.status)
    return URL.createObjectURL(await response.blob())
  }

  return {
    setAccessToken(token) { accessTokenInMemory = token || null },
    clearAccessToken() { accessTokenInMemory = null },
    getMainCategories: () => get('catalog/main-categories'),
    getSubCategories: (id) => get(`catalog/main-categories/${encodeURIComponent(id)}/sub-categories`),
    getConditionTypes: () => get('catalog/condition-types'),
    getMeasurementFields: (id) => get(`catalog/sub-categories/${encodeURIComponent(id)}/measurement-fields`),
    getSeoRecommendation: (input) => post('listings/seo-recommendation', input, { authenticated: true }),
    createListing: (input) => post('listings', input, { authenticated: true }),
    getMyListings: () => get('listings/mine', { authenticated: true }),
    uploadListingImage: (id, slot, file) => upload(`media/listings/${encodeURIComponent(id)}/images?slot=${encodeURIComponent(slot)}`, file),
    submitListing: (id) => post(`listings/${encodeURIComponent(id)}/submit`, {}, { authenticated: true }),
    submitListingRevision: (id, input) => post(`listings/${encodeURIComponent(id)}/revisions`, input, { authenticated: true }),
    getListingRevisions: (id) => get(`listings/${encodeURIComponent(id)}/revisions`, { authenticated: true }),
    withdrawListingRevision: (id) => post(`listings/revisions/${encodeURIComponent(id)}/withdraw`, {}, { authenticated: true }),
    getListingModerationQueue: () => get('listings/moderation-queue', { authenticated: true }),
    confirmListingPhoto: (id) => post(`listings/photos/${encodeURIComponent(id)}/confirm`, {}, { authenticated: true }),
    rejectListingPhoto: (id, reason) => post(`listings/photos/${encodeURIComponent(id)}/reject`, { reason }, { authenticated: true }),
    approveListing: (id) => post(`listings/${encodeURIComponent(id)}/approve`, {}, { authenticated: true }),
    rejectListing: (id, reason) => post(`listings/${encodeURIComponent(id)}/reject`, { reason }, { authenticated: true }),
    getListingRevisionQueue: () => get('listings/revision-moderation-queue', { authenticated: true }),
    approveListingRevision: (id) => post(`listings/revisions/${encodeURIComponent(id)}/approve`, {}, { authenticated: true }),
    rejectListingRevision: (id, reason) => post(`listings/revisions/${encodeURIComponent(id)}/reject`, { reason }, { authenticated: true }),
    getPublicListing: (id) => get(`discovery/listings/${encodeURIComponent(id)}`),
    searchListings: (query) => get(`discovery/search?q=${encodeURIComponent(query)}`),
    getAuthenticatedImage,
    login: (input) => post('users/login', input),
    staffLogin: (input) => post('users/login/totp', input),
    verifyEmailCode: (input) => post('users/login/verify-email-code', input),
    register: (input) => post('users/register', input),
    requestPasswordReset: (email) => post('users/password/forgot', { email }),
    resetPassword: (input) => post('users/password/reset', input),
    refresh: () => post('users/auth/refresh', {}, { refresh: true }),
    logout: () => post('users/logout', {}, { authenticated: true }),
    getSellerApplication: () => get('users/me/seller-application', { authenticated: true }),
    submitSellerApplication: (input) => post('users/seller-applications', input, { authenticated: true }),
    getSellerProfile: () => get('users/me/seller-profile', { authenticated: true }),
    beginAuthenticatorEnrollment: () => post('users/me/authenticator/enroll', {}, { authenticated: true }),
    confirmAuthenticatorEnrollment: (code) => post('users/me/authenticator/confirm', { code }, { authenticated: true }),
    createStepUpGrant: (action, code) => post('users/auth/step-up', { action, code }, { authenticated: true }),
    getPayout: () => get('users/me/payout', { authenticated: true }),
    updatePayout: (input) => send('PATCH', 'users/me/payout-method', input, { authenticated: true }),
    getAdminApplications: () => get('admin/seller-applications', { authenticated: true }),
    reviewSellerApplication: (id, decision, reason) => post(`admin/seller-applications/${encodeURIComponent(id)}/review`, { decision, reason }, { authenticated: true }),
    verifySellerIdentity: (id, note) => post(`admin/sellers/${encodeURIComponent(id)}/identity-verification`, { note }, { authenticated: true }),
    getAdminPayouts: () => get('admin/payouts', { authenticated: true }),
    setPayoutHold: (id, reason) => post(`admin/payouts/${encodeURIComponent(id)}/hold`, { reason }, { authenticated: true }),
    clearPayoutHold: (id, reason) => post(`admin/payouts/${encodeURIComponent(id)}/hold/clear`, { reason }, { authenticated: true }),
  }
}

export const api = createApiClient()
