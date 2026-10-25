import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSearchUrl, getBuyDestination, getListingViewState, getLoginReturnTo } from './browse.js'

test('filter values map to the discovery search URL parameter names', () => {
  assert.equal(
    buildSearchUrl({
      query: ' silk ',
      filters: {
        mainCategoryId: 'main-1',
        subCategoryId: 'sub-1',
        condition: 'pre_owned',
        minPrice: '1000',
        maxPrice: '5000',
        cityId: 'city-1',
        colorId: 'color-1',
        brandId: 'brand-1',
        fabricId: 'fabric-1',
      },
      sort: 'price-asc',
      cursor: 'next-page',
    }),
    '/search?q=silk&mainCategoryId=main-1&subCategoryId=sub-1&condition=pre_owned&minPrice=1000&maxPrice=5000&cityId=city-1&colorId=color-1&brandId=brand-1&fabricId=fabric-1&sort=price-asc&cursor=next-page',
  )
})

test('Buy redirects guests to login and returns them to the listing', () => {
  const destination = getBuyDestination({ authenticated: false, listingPath: '/listing/kurta-ab12' })
  assert.equal(destination.type, 'login')
  assert.equal(new URL(destination.url, 'https://poshaak.test').searchParams.get('returnTo'), '/listing/kurta-ab12')
})

test('Buy sends signed-in users to checkout state', () => {
  assert.deepEqual(getBuyDestination({ authenticated: true, listingPath: '/listing/kurta-ab12' }), { type: 'checkout' })
})

test('login return path accepts internal paths only', () => {
  assert.equal(getLoginReturnTo('?returnTo=%2Flisting%2Fkurta-ab12'), '/listing/kurta-ab12')
  assert.equal(getLoginReturnTo('?returnTo=%2F%2Fevil.test'), '/account')
})

test('sold and removed listings have distinct rendering states', () => {
  assert.equal(getListingViewState(200, { sold: true }), 'sold')
  assert.equal(getListingViewState(410, null), 'gone')
  assert.equal(getListingViewState(200, { unavailable: true }), 'unavailable')
})
