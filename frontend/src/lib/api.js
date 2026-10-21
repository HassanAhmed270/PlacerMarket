const DEFAULT_API_BASE_URL = 'http://localhost:3000/api'
export const AUTH_MOCK_ENABLED = Boolean(import.meta.env?.DEV && import.meta.env?.VITE_AUTH_MOCK === 'true')

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

  async function get(path, { signal } = {}) {
    const response = await fetchImpl(`${normalizedBaseUrl}/${path.replace(/^\/+/, '')}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
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

  async function post(path, body, { accessToken, refresh = false } = {}) {
    if (AUTH_MOCK_ENABLED && path === 'users/login') return { challengeRequired: true, factor: 'email', loginAttemptId: 'development-only-attempt' }
    if (AUTH_MOCK_ENABLED && path === 'users/login/verify-email-code') return { accessToken: 'development-only-memory-token', tokenType: 'Bearer', expiresIn: 900 }
    if (AUTH_MOCK_ENABLED && path === 'users/register') return { message: 'Development mock registration accepted.' }
    if (AUTH_MOCK_ENABLED && path.startsWith('users/password/')) return { message: 'Development mock request accepted.' }
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' }
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`
    const response = await fetchImpl(`${normalizedBaseUrl}/${path.replace(/^\/+/, '')}`, {
      method: 'POST', headers, body: JSON.stringify(body),
      ...(refresh ? { credentials: 'include' } : {}),
    })
    let result = null
    try { result = await response.json() } catch { /* Empty success response. */ }
    if (!response.ok) throw Object.assign(new ApiError(response.status), { payload: result })
    return result
  }

  return {
    getMainCategories: () => get('catalog/main-categories'),
    login: (input) => post('users/login', input),
    staffLogin: (input) => post('users/login/totp', input),
    verifyEmailCode: (input) => post('users/login/verify-email-code', input),
    register: (input) => post('users/register', input),
    requestPasswordReset: (email) => post('users/password/forgot', { email }),
    resetPassword: (input) => post('users/password/reset', input),
    refresh: () => post('users/auth/refresh', {}, { refresh: true }),
  }
}

export const api = createApiClient()
