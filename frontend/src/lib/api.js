const DEFAULT_API_BASE_URL = 'http://localhost:3000/api'

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

  return {
    getMainCategories: () => get('catalog/main-categories'),
  }
}

export const api = createApiClient()
