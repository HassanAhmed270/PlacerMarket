import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getHttpsEvidenceHref, validateDisputeForm } from './disputes.js'

test('FR-43b: dispute reasons must contain nonblank free text', () => {
  const result = validateDisputeForm({
    reasonText: '   ',
    evidenceUrls: ['https://evidence.example/item.jpg'],
    maxEvidenceUrls: 2,
  })

  assert.equal(result.valid, false)
  assert.equal(result.errors.reasonText, 'Enter a reason for reporting this problem.')
})

test('FR-43a: dispute filing requires one or more evidence URLs within the server limit', () => {
  const empty = validateDisputeForm({ reasonText: 'Item differs', evidenceUrls: [''], maxEvidenceUrls: 2 })
  const tooMany = validateDisputeForm({
    reasonText: 'Item differs',
    evidenceUrls: ['https://evidence.example/1', 'https://evidence.example/2', 'https://evidence.example/3'],
    maxEvidenceUrls: 2,
  })
  const valid = validateDisputeForm({
    reasonText: ' Item differs ',
    evidenceUrls: [' https://evidence.example/item.jpg '],
    maxEvidenceUrls: 2,
  })

  assert.equal(empty.errors.evidenceUrls, 'Add at least one HTTPS evidence URL.')
  assert.equal(tooMany.valid, false)
  assert.equal(valid.valid, true)
  assert.equal(valid.reasonText, 'Item differs')
  assert.deepEqual(valid.evidenceUrls, ['https://evidence.example/item.jpg'])
})

test('FR-43a: non-HTTPS evidence schemes are rejected and displayed only as text', () => {
  for (const value of ['javascript:alert(1)', 'data:text/plain,proof', 'http://evidence.example/item.jpg']) {
    assert.equal(getHttpsEvidenceHref(value), null)
    assert.equal(validateDisputeForm({
      reasonText: 'Item differs',
      evidenceUrls: [value],
      maxEvidenceUrls: 2,
    }).valid, false)
  }

  assert.equal(getHttpsEvidenceHref('https://evidence.example/item.jpg'), 'https://evidence.example/item.jpg')
})
