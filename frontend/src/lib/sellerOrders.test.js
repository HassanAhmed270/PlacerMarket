import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getSellerDisputeLabel,
  getSellerHandoverDeadline,
  getSellerOrderStatusMessage,
  getSellerPayoutLabel,
} from './sellerOrders.js'

test('FR-34: seller order labels cover every funded and delivery status', () => {
  assert.deepEqual(getSellerOrderStatusMessage('funded'), {
    title: 'Paid',
    message: 'Payment is confirmed.',
  })
  assert.deepEqual(getSellerOrderStatusMessage('handed_to_delivery'), {
    title: 'Handed to delivery',
    message: 'The order has been handed to the delivery partner.',
  })
  assert.deepEqual(getSellerOrderStatusMessage('held'), {
    title: 'Delivered',
    message: 'The order has been marked delivered.',
  })
  assert.deepEqual(getSellerOrderStatusMessage('delivered'), {
    title: 'Delivered',
    message: 'The order has been marked delivered.',
  })
  assert.deepEqual(getSellerOrderStatusMessage('completed'), {
    title: 'Order complete',
    message: 'This order is complete.',
  })
  assert.deepEqual(getSellerOrderStatusMessage('cancelled'), {
    title: 'Order cancelled',
    message: 'This order was cancelled.',
  })
  assert.deepEqual(getSellerOrderStatusMessage('unexpected'), {
    title: 'Order status',
    message: 'The latest order status is shown here.',
  })
})

test('FR-34: seller handover deadline labels apply only to funded orders', () => {
  const deadline = '2026-11-07T10:00:00.000Z'
  const deadlineText = `Handover deadline: ${new Date(deadline).toLocaleString()}`
  assert.deepEqual(getSellerHandoverDeadline('funded', deadline, Date.parse('2026-11-07T10:00:01.000Z')), {
    text: deadlineText,
    overdue: true,
  })
  assert.deepEqual(getSellerHandoverDeadline('funded', deadline, Date.parse('2026-11-07T09:59:59.000Z')), {
    text: deadlineText,
    overdue: false,
  })
  for (const status of ['handed_to_delivery', 'held', 'delivered', 'completed', 'cancelled']) {
    assert.deepEqual(getSellerHandoverDeadline(status, deadline, Date.parse('2026-11-07T10:00:01.000Z')), {
      text: '',
      overdue: false,
    })
  }
  assert.deepEqual(getSellerHandoverDeadline('funded', null, Date.parse('2026-11-07T09:59:59.000Z')), {
    text: '',
    overdue: false,
  })
})

test('FR-34: seller payout labels cover every payout hold state', () => {
  assert.equal(
    getSellerPayoutLabel('held'),
    'Payout held. Our team releases it manually after the hold and complaint periods.'
  )
  assert.equal(getSellerPayoutLabel('paused_for_dispute'), 'Payout paused because of a dispute.')
  assert.equal(getSellerPayoutLabel('released'), 'Payout released.')
  assert.equal(getSellerPayoutLabel('force_released'), 'Payout released.')
  assert.equal(getSellerPayoutLabel(null), 'No payout hold yet.')
})

test('FR-34: seller dispute labels cover every dispute status and leave null unlabeled', () => {
  assert.equal(getSellerDisputeLabel('open'), 'A dispute is open.')
  assert.equal(getSellerDisputeLabel('seller_responded'), 'A dispute is open.')
  assert.equal(getSellerDisputeLabel('resolved_release'), 'The dispute was decided in your favour.')
  assert.equal(
    getSellerDisputeLabel('resolved_refund'),
    "The dispute was decided in the buyer's favour; payout stays paused."
  )
  assert.equal(getSellerDisputeLabel('resolved_other'), 'The dispute is closed.')
  assert.equal(getSellerDisputeLabel(null), null)
})
