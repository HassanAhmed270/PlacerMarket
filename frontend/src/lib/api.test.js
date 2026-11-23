import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ApiError, createApiClient, resolveApiBaseUrl } from './api.js'

test('FR-84: development API default follows the page host and production requires configuration', () => {
  assert.equal(resolveApiBaseUrl({
    development: true,
    location: { hostname: '127.0.0.1', protocol: 'http:' },
  }), 'http://127.0.0.1:3000/api')
  assert.equal(resolveApiBaseUrl({ configuredBaseUrl: 'https://api.example.test/api', production: true }),
    'https://api.example.test/api')
  assert.throws(() => resolveApiBaseUrl({ production: true }), /VITE_API_BASE_URL must be set/)
})

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
    assert.deepEqual(error.payload, { error: 'database details' })
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

test('FR-84: concurrent refresh calls share one in-flight refresh request', async () => {
  let calls = 0
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api',
    fetchImpl: async () => {
      calls += 1
      await pending
      return { ok: true, status: 200, json: async () => ({ accessToken: 'refreshed-token' }) }
    },
  })

  const first = client.refresh()
  const second = client.refresh()
  await Promise.resolve()
  assert.equal(calls, 1)
  release()
  assert.deepEqual(await Promise.all([first, second]), [
    { accessToken: 'refreshed-token' },
    { accessToken: 'refreshed-token' },
  ])
})

test('FR-84: an authenticated 401 silently refreshes once and retries once', async () => {
  const calls = []
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api',
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      if (url.endsWith('/users/auth/refresh')) {
        return { ok: true, status: 200, json: async () => ({ accessToken: 'refreshed-token' }) }
      }
      if (calls.filter((call) => call.url.endsWith('/orders/order-1/summary')).length === 1) {
        return { ok: false, status: 401, json: async () => ({ error: 'expired' }) }
      }
      return { ok: true, status: 200, json: async () => ({ orderId: 'order-1' }) }
    },
  })
  client.setAccessToken('expired-token')

  await client.getOrderSummary('order-1')

  assert.equal(calls.length, 3)
  assert.equal(calls[0].options.headers.Authorization, 'Bearer expired-token')
  assert.equal(calls[1].options.credentials, 'include')
  assert.equal(calls[1].options.headers.Authorization, undefined)
  assert.equal(calls[2].options.headers.Authorization, 'Bearer refreshed-token')
  client.clearAccessToken()
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

test('Admin APIs call the existing protected routes with their exact methods and bodies', async () => {
  const calls = []
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api',
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return { ok: true, status: 200, json: async () => ({}) }
    },
  })
  client.setAccessToken('short-lived-memory-token')
  await client.getAdminOrders({ limit: 20, status: 'funded', before: 'cursor-id' })
  await client.getAdminOrder('order-1')
  await client.getAdminManualRefunds({ limit: 20, before: 'refund-cursor' })
  await client.getAdminManualRefund('refund-1')
  await client.getAdminRefundableBalance('order-1')
  await client.requestAdminManualRefund('order-1', { reason: 'Reviewed customer delivery concern.', stepUpGrant: 'request-grant' })
  await client.decideAdminManualRefund('refund-1', 'approve', { reason: 'Second Admin approved the request.', stepUpGrant: 'decision-grant' })
  await client.recordAdminHandover('order-1', { status: 'handed_to_delivery', courierPickupAt: '2026-11-07T10:00:00+00:00', handoverConfirmationNote: 'Courier picked up' })
  await client.markAdminOrderDelivered('order-1', { note: 'Delivery confirmed' })
  await client.releaseAdminOrderPayout('order-1', { payoutReference: 'ref-123', note: 'Manual transfer recorded' })
  await client.getAdminExceptions({ status: 'unresolved', kind: 'handover_after_cancel', limit: 100 })
  await client.resolveAdminException('exception-1', 'Resolution recorded')
  await client.getAdminDisputes({ status: 'open' })
  await client.getAdminDisputeEvidence('dispute-1')
  await client.resolveAdminDispute('dispute-1', { resolutionAmountToBuyer: '0' })
  client.clearAccessToken()

  assert.deepEqual(calls.map(({ url, options }) => [url, options.method]), [
    ['https://api.example.test/api/admin/orders?limit=20&status=funded&before=cursor-id', 'GET'],
    ['https://api.example.test/api/admin/orders/order-1', 'GET'],
    ['https://api.example.test/api/admin/refunds?limit=20&before=refund-cursor', 'GET'],
    ['https://api.example.test/api/admin/refunds/refund-1', 'GET'],
    ['https://api.example.test/api/admin/orders/order-1/refundable-balance', 'GET'],
    ['https://api.example.test/api/admin/orders/order-1/refunds', 'POST'],
    ['https://api.example.test/api/admin/refunds/refund-1/approve', 'POST'],
    ['https://api.example.test/api/admin/orders/order-1/delivery', 'PATCH'],
    ['https://api.example.test/api/admin/orders/order-1/delivered', 'POST'],
    ['https://api.example.test/api/admin/orders/order-1/payout/release', 'POST'],
    ['https://api.example.test/api/admin/order-exceptions?status=unresolved&kind=handover_after_cancel&limit=100', 'GET'],
    ['https://api.example.test/api/admin/order-exceptions/exception-1/resolve', 'POST'],
    ['https://api.example.test/api/disputes?status=open', 'GET'],
    ['https://api.example.test/api/disputes/dispute-1/evidence', 'GET'],
    ['https://api.example.test/api/disputes/dispute-1/resolve', 'POST'],
  ])
  assert.deepEqual(JSON.parse(calls[7].options.body), {
    status: 'handed_to_delivery',
    courierPickupAt: '2026-11-07T10:00:00+00:00',
    handoverConfirmationNote: 'Courier picked up',
  })
  assert.deepEqual(JSON.parse(calls[9].options.body), { payoutReference: 'ref-123', note: 'Manual transfer recorded' })
  assert.deepEqual(JSON.parse(calls[5].options.body), {
    reason: 'Reviewed customer delivery concern.',
    stepUpGrant: 'request-grant',
  })
  assert.deepEqual(JSON.parse(calls[6].options.body), {
    reason: 'Second Admin approved the request.',
    stepUpGrant: 'decision-grant',
  })
  assert.ok(calls.every(({ options }) => options.headers.Authorization?.startsWith('Bearer ')))
})

test('FR-48, FR-58, FR-65: payout Admin APIs use protected paths and keep step-up grants in JSON bodies', async () => {
  const calls = []
  const csv = 'payout_id,status,amount\r\npayout-1,paid,125.00\r\n'
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api',
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => csv,
      }
    },
  })

  client.setAccessToken('short-lived-memory-token')
  await client.getAdminPayoutSettings()
  await client.getAdminSellerPayouts({ status: 'failed', limit: 20 })
  await client.getAdminSellerPayout('payout-1')
  await client.approveAdminSellerPayout('payout-1', { stepUpGrant: 'approve-grant' })
  await client.markAdminSellerPayoutPaid('payout-1', {
    method: 'bank',
    transferReference: 'BANK-123',
    paidOn: '2026-11-16',
    note: 'Transfer recorded',
    stepUpGrant: 'paid-grant',
  })
  await client.markAdminSellerPayoutFailed('payout-1', { reason: 'Transfer returned', stepUpGrant: 'failed-grant' })
  await client.retryAdminSellerPayout('payout-1', { stepUpGrant: 'retry-grant' })
  assert.equal(await client.exportAdminSellerPayouts({
    status: 'paid',
    from: '2026-11-01',
    to: '2026-11-16',
    stepUpGrant: 'export-grant',
  }), csv)
  await client.getAdminHeldFunds({ state: 'held', needsDecision: 'true', limit: 100 })
  await client.decideAdminHeldFunds('held-1', {
    decision: 'keep_held',
    note: 'Identity review is pending.',
    stepUpGrant: 'held-grant',
  })
  await client.updateAdminCommission('6.50', 'commission-grant')
  client.clearAccessToken()

  assert.deepEqual(calls.map(({ url, options }) => [url, options.method]), [
    ['https://api.example.test/api/admin/payout-settings', 'GET'],
    ['https://api.example.test/api/admin/seller-payouts?status=failed&limit=20', 'GET'],
    ['https://api.example.test/api/admin/seller-payouts/payout-1', 'GET'],
    ['https://api.example.test/api/admin/seller-payouts/payout-1/approve', 'POST'],
    ['https://api.example.test/api/admin/seller-payouts/payout-1/paid', 'POST'],
    ['https://api.example.test/api/admin/seller-payouts/payout-1/failed', 'POST'],
    ['https://api.example.test/api/admin/seller-payouts/payout-1/retry', 'POST'],
    ['https://api.example.test/api/admin/seller-payouts/export', 'POST'],
    ['https://api.example.test/api/admin/held-funds?state=held&needsDecision=true&limit=100', 'GET'],
    ['https://api.example.test/api/admin/held-funds/held-1/decision', 'POST'],
    ['https://api.example.test/api/admin/fees/commission', 'PATCH'],
  ])
  assert.deepEqual(JSON.parse(calls[3].options.body), { stepUpGrant: 'approve-grant' })
  assert.deepEqual(JSON.parse(calls[4].options.body), {
    method: 'bank',
    transferReference: 'BANK-123',
    paidOn: '2026-11-16',
    note: 'Transfer recorded',
    stepUpGrant: 'paid-grant',
  })
  assert.deepEqual(JSON.parse(calls[7].options.body), {
    status: 'paid',
    from: '2026-11-01',
    to: '2026-11-16',
    stepUpGrant: 'export-grant',
  })
  assert.deepEqual(JSON.parse(calls[9].options.body), {
    decision: 'keep_held',
    note: 'Identity review is pending.',
    stepUpGrant: 'held-grant',
  })
  assert.deepEqual(JSON.parse(calls[10].options.body), { percent: '6.50', stepUpGrant: 'commission-grant' })
  assert.ok(calls.every(({ options }) => options.headers.Authorization === 'Bearer short-lived-memory-token'))
  assert.ok(calls.every(({ url }) => !url.includes('grant')))
  assert.equal(calls[7].options.headers.Accept.includes('text/csv'), true)
})

test('FR-58: commission update includes its step-up grant and sends no request without one', async () => {
  const calls = []
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api',
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return new Response(JSON.stringify({ value: '6.50' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  client.setAccessToken('commission-test-token')
  await client.updateAdminCommission('6.50', 'commission-step-up-grant')
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    percent: '6.50',
    stepUpGrant: 'commission-step-up-grant',
  })
  assert.throws(
    () => client.updateAdminCommission('6.50'),
    /step-up grant is required/
  )
  assert.equal(calls.length, 1)
  client.clearAccessToken()
})

test('FR-48: payout CSV errors preserve structured API messages', async () => {
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api',
    fetchImpl: async () => ({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ error: 'Export limit exceeded.' }),
    }),
  })

  await assert.rejects(client.exportAdminSellerPayouts({ stepUpGrant: 'export-grant' }), (error) => {
    assert.equal(error.status, 409)
    assert.deepEqual(error.payload, { error: 'Export limit exceeded.' })
    return true
  })
})

test('FR-34: seller order APIs use authenticated reads and cursor query parameters', async () => {
  const calls = []
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api',
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return { ok: true, status: 200, json: async () => ({ orders: [], nextBefore: null }) }
    },
  })
  client.setAccessToken('short-lived-memory-token')
  await client.getSellingOrders({ limit: 20, before: 'cursor-id' })
  await client.getSellingOrder('order-1')

  assert.deepEqual(calls.map(({ url, options }) => [url, options.method]), [
    ['https://api.example.test/api/orders/selling?limit=20&before=cursor-id', 'GET'],
    ['https://api.example.test/api/orders/selling/order-1', 'GET'],
  ])
  assert.ok(calls.every(({ options }) => options.headers.Authorization?.startsWith('Bearer ')))
})

test('FR-43, FR-43a, FR-43b: Buyer dispute filing sends reason and evidence to the authenticated route', async () => {
  let call
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api',
    fetchImpl: async (url, options) => {
      call = { url, options }
      return { ok: true, status: 201, json: async () => ({ id: 'dispute-1', status: 'open' }) }
    },
  })
  client.setAccessToken('short-lived-memory-token')

  await client.fileDispute('order-1', {
    reasonText: 'The delivered item differs from the listing',
    evidenceUrls: ['https://evidence.example/photo.jpg'],
  })

  assert.equal(call.url, 'https://api.example.test/api/disputes/orders/order-1')
  assert.equal(call.options.method, 'POST')
  assert.equal(call.options.headers.Authorization, 'Bearer short-lived-memory-token')
  assert.deepEqual(JSON.parse(call.options.body), {
    reasonText: 'The delivered item differs from the listing',
    evidenceUrls: ['https://evidence.example/photo.jpg'],
  })
})

test('FR-43, FR-43c, FR-27b: seller order mutation APIs use exact authenticated paths and bodies', async () => {
  const calls = []
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api',
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return { ok: true, status: 200, json: async () => ({}) }
    },
  })
  client.setAccessToken('seller-memory-token')

  await client.fileReturnRequest('order-1', { reason: 'The item arrived damaged.' })
  await client.respondToReturnRequest('return-1', 'I will provide a pickup response.')
  await client.submitCounterEvidence('dispute-1', {
    responseText: 'The listing accurately described the item.',
    evidenceUrls: ['https://evidence.example/counter.jpg'],
  })
  await client.addDisputeEvidence('dispute-1', { note: 'The buyer also confirmed the package condition.' })
  await client.addDisputeEvidence('dispute-2', { mediaReference: 'https://evidence.example/photo.jpg' })
  await client.getPartyDisputeEvidence('dispute-1')
  await client.withdrawDispute('dispute-1')
  await client.submitOrderReview('order-1', { rating: 5, itemRating: 4, body: 'Completed the handover promptly.' })
  await client.reportReview('review-1', 'This review contains inappropriate content.')
  await client.getSellerReviews('seller-1', { limit: 20, cursor: 'review-cursor' })

  assert.deepEqual(calls.map(({ url, options }) => [url, options.method]), [
    ['https://api.example.test/api/returns/orders/order-1', 'POST'],
    ['https://api.example.test/api/returns/return-1/respond', 'POST'],
    ['https://api.example.test/api/disputes/dispute-1/counter-evidence', 'POST'],
    ['https://api.example.test/api/disputes/dispute-1/evidence', 'POST'],
    ['https://api.example.test/api/disputes/dispute-2/evidence', 'POST'],
    ['https://api.example.test/api/disputes/dispute-1/party-evidence', 'GET'],
    ['https://api.example.test/api/disputes/dispute-1/withdraw', 'POST'],
    ['https://api.example.test/api/orders/order-1/reviews', 'POST'],
    ['https://api.example.test/api/reviews/review-1/reports', 'POST'],
    ['https://api.example.test/api/reviews/sellers/seller-1?limit=20&cursor=review-cursor', 'GET'],
  ])
  assert.deepEqual(JSON.parse(calls[0].options.body), { reason: 'The item arrived damaged.' })
  assert.deepEqual(JSON.parse(calls[1].options.body), { sellerNote: 'I will provide a pickup response.' })
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    responseText: 'The listing accurately described the item.',
    evidenceUrls: ['https://evidence.example/counter.jpg'],
  })
  assert.deepEqual(JSON.parse(calls[3].options.body), { note: 'The buyer also confirmed the package condition.' })
  assert.deepEqual(JSON.parse(calls[4].options.body), { mediaReference: 'https://evidence.example/photo.jpg' })
  assert.deepEqual(JSON.parse(calls[6].options.body), {})
  assert.deepEqual(JSON.parse(calls[7].options.body), {
    rating: 5,
    itemRating: 4,
    body: 'Completed the handover promptly.',
  })
  assert.deepEqual(JSON.parse(calls[8].options.body), { reason: 'This review contains inappropriate content.' })
  assert.ok(calls.slice(0, 9).every(({ options }) => options.headers.Authorization === 'Bearer seller-memory-token'))
  assert.equal(calls[9].options.headers.Authorization, undefined)

  let requestCount = calls.length
  assert.throws(() => client.respondToReturnRequest('return-1', 'xx'), /3 to 300/)
  assert.throws(() => client.submitOrderReview('order-1', { rating: 0 }), /1 to 5/)
  assert.throws(() => client.submitOrderReview('order-1', { rating: 5, itemRating: 0 }), /1 to 5/)
  assert.throws(() => client.addDisputeEvidence('dispute-1', { note: 'no' }), /3 to 500/)
  assert.equal(calls.length, requestCount)
})
