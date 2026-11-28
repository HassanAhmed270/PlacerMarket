import test from 'node:test'
import assert from 'node:assert/strict'
import { formatPublicReview, getReviewModerationActions, getReviewStateLabel } from './reviewHelpers.js'

test('public review formatter handles complete, optional and missing fields', () => {
  assert.deepEqual(formatPublicReview({
    rating: 5,
    itemRating: 4,
    createdAt: '2026-03-20T00:00:00.000Z',
    reviewer: { displayName: 'Ada L.' },
  }), {
    rating: '5 stars',
    itemRating: 'Item rating: 4/5',
    date: '20 Mar 2026',
    reviewer: 'Ada L.',
  })
  assert.deepEqual(formatPublicReview(null), {
    rating: 'Rating unavailable',
    itemRating: null,
    date: 'Date unavailable',
    reviewer: 'Reviewer',
  })
  assert.equal(formatPublicReview({ rating: 1 }).rating, '1 star')
})

test('moderation action table hides already-hidden and gates restore', () => {
  assert.deepEqual(getReviewModerationActions({ state: 'visible' }, true), {
    canHide: true,
    canRestore: false,
  })
  assert.deepEqual(getReviewModerationActions({ state: 'hidden_by_admin' }, true), {
    canHide: false,
    canRestore: true,
  })
  assert.deepEqual(getReviewModerationActions({ state: 'hidden_by_admin' }, false), {
    canHide: false,
    canRestore: false,
  })
})

test('review state labels translate known states and hide unknown state values', () => {
  assert.equal(getReviewStateLabel('visible'), 'Visible')
  assert.equal(getReviewStateLabel('hidden_by_admin'), 'Hidden by a moderator')
  assert.equal(getReviewStateLabel('hidden_until_reveal'), 'Waiting for both reviews')
  assert.equal(getReviewStateLabel('unexpected'), 'Status unavailable')
  assert.equal(getReviewStateLabel('__proto__'), 'Status unavailable')
  assert.equal(getReviewStateLabel(null), 'Status unavailable')
})
