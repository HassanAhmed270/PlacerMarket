import test from 'node:test'
import assert from 'node:assert/strict'
import { visibleAdminLinks } from './adminNavigation.js'

test('Admin navigation includes all payout links for Admin', () => {
  const links = visibleAdminLinks('admin').map((link) => link.href)
  assert.equal(links.length, 9)
  assert.ok(links.includes('/admin/seller-payouts'))
  assert.ok(links.includes('/admin/held-funds'))
  assert.ok(links.includes('/admin/payout-settings'))
  assert.ok(links.includes('/admin/reviews'))
})

test('Moderator navigation hides Admin-only payout links', () => {
  const links = visibleAdminLinks('moderator').map((link) => link.href)
  assert.ok(links.includes('/admin/disputes'))
  assert.equal(links.length, 1)
  assert.ok(!links.includes('/admin/orders'))
  assert.ok(!links.includes('/admin/exceptions'))
  assert.ok(!links.includes('/admin/refunds'))
  assert.ok(!links.includes('/admin/delivery-cities'))
  assert.ok(!links.includes('/admin/seller-payouts'))
  assert.ok(!links.includes('/admin/held-funds'))
  assert.ok(!links.includes('/admin/payout-settings'))
  assert.ok(!links.includes('/admin/reviews'))
})

test('Unknown role navigation shows no payout links', () => {
  const links = visibleAdminLinks('unknown').map((link) => link.href)
  assert.deepEqual(links, [])
  assert.ok(!links.includes('/admin/seller-payouts'))
  assert.ok(!links.includes('/admin/held-funds'))
  assert.ok(!links.includes('/admin/payout-settings'))
})
