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

test('public search client encodes the query in the existing discovery endpoint', async () => {
  let requestUrl
  const client = createApiClient({
    baseUrl: 'http://localhost:3000/api',
    fetchImpl: async (url) => {
      requestUrl = url
      return { ok: true, status: 200, json: async () => ({ items: [], nextCursor: null, hasNextPage: false }) }
    },
  })

  const result = await client.searchListings('silk outfit')

  assert.equal(requestUrl, 'http://localhost:3000/api/discovery/search?q=silk%20outfit')
  assert.deepEqual(result, { items: [], nextCursor: null, hasNextPage: false })
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

test('FR-83c/f: protected seller API requests use only the in-memory access token', async () => {
  const calls = []
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api',
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return { ok: true, status: 200, json: async () => ({ status: 'pending' }) }
    },
  })
  client.setAccessToken('short-lived-memory-token')
  await client.getSellerApplication()
  assert.equal(calls[0].url, 'https://api.example.test/api/users/me/seller-application')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer short-lived-memory-token')
  client.clearAccessToken()
  await client.getSellerApplication()
  assert.equal(calls[1].options.headers.Authorization, undefined)
  assert.equal(Object.hasOwn(globalThis, 'localStorage'), false)
})

test('FR-74: listing image upload sends raw bytes with the in-memory bearer token', async () => {
  let call
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api',
    fetchImpl: async (url, options) => {
      call = { url, options }
      return { ok: true, status: 202, json: async () => ({ id: 'image-1', processing_state: 'pending' }) }
    },
  })
  const file = new Blob(['png-bytes'], { type: 'image/png' })
  client.setAccessToken('short-lived-memory-token')
  const uploaded = await client.uploadListingImage('listing-1', 'front', file)
  assert.equal(call.url, 'https://api.example.test/api/media/listings/listing-1/images?slot=front')
  assert.equal(call.options.method, 'POST')
  assert.equal(call.options.headers.Authorization, 'Bearer short-lived-memory-token')
  assert.equal(call.options.headers['Content-Type'], 'application/octet-stream')
  assert.equal(call.options.body, file)
  assert.equal(uploaded.processing_state, 'pending')
})

test('customer and moderation APIs use the existing authenticated routes', async () => {
  const calls = []
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api',
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return { ok: true, status: 200, json: async () => [] }
    },
  })
  client.setAccessToken('short-lived-memory-token')
  await client.getFavorites({ limit: 20 })
  await client.getConversationInbox()
  await client.getConversationMessages('conversation-1')
  await client.markConversationRead('conversation-1')
  await client.sendConversationMessage('conversation-1', 'Hello')
  await client.getNotifications({ unreadOnly: true })
  await client.markNotificationRead('notification-1')
  await client.getListingStatus('listing-1')
  await client.getManagedAttributeApprovalQueue()
  await client.approveManagedAttribute('attribute-1')
  await client.rejectManagedAttribute('attribute-2', 'Not an appropriate catalog value')

  assert.deepEqual(calls.map(({ url, options }) => [url, options.method]), [
    ['https://api.example.test/api/discovery/favorites?limit=20', 'GET'],
    ['https://api.example.test/api/negotiation/conversations', 'GET'],
    ['https://api.example.test/api/negotiation/conversations/conversation-1/messages', 'GET'],
    ['https://api.example.test/api/negotiation/conversations/conversation-1/read', 'PATCH'],
    ['https://api.example.test/api/negotiation/conversations/conversation-1/messages', 'POST'],
    ['https://api.example.test/api/notifications?unreadOnly=true', 'GET'],
    ['https://api.example.test/api/notifications/notification-1/read', 'PATCH'],
    ['https://api.example.test/api/discovery/listings/listing-1/status', 'GET'],
    ['https://api.example.test/api/catalog/attribute-approval-queue', 'GET'],
    ['https://api.example.test/api/catalog/attributes/attribute-1/approve', 'POST'],
    ['https://api.example.test/api/catalog/attributes/attribute-2/reject', 'POST'],
  ])
  assert.deepEqual(calls
    .filter(({ url, options }) => !url.endsWith('/discovery/listings/listing-1/status') && !options.headers.Authorization)
    .map(({ url }) => url), [])
})
