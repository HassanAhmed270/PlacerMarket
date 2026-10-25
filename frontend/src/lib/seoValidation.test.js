import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getMessageErrorMessage, getSeoValidation } from './seoValidation.js'

test('contact-detail block is shown as a clear, actionable message', () => {
  const message = getMessageErrorMessage({
    payload: { error: 'Messages cannot contain phone numbers, email addresses, or links.' },
  })
  assert.match(message, /Contact details are blocked/)
  assert.match(message, /phone numbers, email addresses, or links/)
  assert.match(message, /Please keep contact on Poshaak/)
})

test('SEO chooser validation enforces live length and replica guardrails', () => {
  assert.deepEqual(getSeoValidation({
    title: 'Silk dress',
    description: 'A lovely pre-owned silk dress.',
    condition: 'pre_owned',
    required: true,
  }), [])
  assert.deepEqual(getSeoValidation({
    title: 'A'.repeat(61),
    description: 'D'.repeat(156),
    condition: 'replica',
    required: true,
  }), [
    'SEO title must be 60 characters or fewer.',
    'SEO description must be 155 characters or fewer.',
    'Replica listings must include "Replica" in the SEO title.',
  ])
  assert.deepEqual(getSeoValidation({
    title: 'Replica designer dress',
    description: 'An authentic original design.',
    condition: 'replica',
    required: true,
  }), ['Replica listing SEO text cannot call the item original or authentic.'])
})
