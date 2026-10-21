import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ApiError, createApiClient } from './api.js'

test('public catalog client requests the existing main-categories endpoint', async () => {
  let requestUrl
  let requestOptions
  const client = createApiClient({
    baseUrl: 'http://localhost:3000/api/',
    fetchImpl: async (url, options) => {
      requestUrl = url
      requestOptions = options
      return { ok: true, status: 200, json: async () => [{ id: 'category-1', name: 'Clothing' }] }
    },
  })

  const categories = await client.getMainCategories()

  assert.equal(requestUrl, 'http://localhost:3000/api/catalog/main-categories')
  assert.equal(requestOptions.method, 'GET')
  assert.deepEqual(categories, [{ id: 'category-1', name: 'Clothing' }])
})

test('API client reports non-success responses without exposing response content', async () => {
  const client = createApiClient({
    baseUrl: 'http://localhost:3000/api',
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: 'database details' }) }),
  })

  await assert.rejects(client.getMainCategories(), (error) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 503)
    assert.equal(error.message, 'The API request failed with status 503.')
    assert.equal(error.message.includes('database details'), false)
    return true
  })
})

test('FR-84, SEC-04/05: login uses a bearer challenge flow and refresh sends only the refresh cookie', async () => {
  const calls = []
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api',
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return { ok: true, status: 200, json: async () => ({ accessToken: 'short-lived-token' }) }
    },
  })
  await client.login({ email: 'buyer@example.test', password: 'correct-horse-battery' })
  await client.refresh()
  assert.equal(calls[0].url, 'https://api.example.test/api/users/login')
  assert.equal(calls[0].options.headers.Authorization, undefined)
  assert.equal(calls[1].url, 'https://api.example.test/api/users/auth/refresh')
  assert.equal(calls[1].options.credentials, 'include')
  assert.equal(calls[1].options.headers.Authorization, undefined)
  assert.equal(Object.hasOwn(globalThis, 'localStorage'), false)
})
