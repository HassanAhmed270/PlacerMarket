import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './lib/api.js'
import {
  adminErrorMessage,
  adminHandoverErrorMessage,
  adminStatusLabel,
  buildAdminOrderQuery,
  formatAdminAmount,
  formatAdminDate,
  isRecordedHandoverConflict,
  localDateTimeToIsoWithOffset,
  orderActionEligibility,
  payoutReleaseMessage,
  validateHandoverForm,
  validatePayoutForm,
} from './lib/admin.js'

const ORDER_STATUSES = [
  'bag', 'order_placed', 'seller_preparing', 'reserved', 'payment_pending',
  'funded', 'handed_to_delivery', 'out_for_delivery', 'delivered', 'held',
  'completed', 'cancelled', 'refused_at_door', 'return_requested', 'returned',
]

export default function AdminOrders({ orderId = '' }) {
  return orderId ? <AdminOrderDetail orderId={orderId} /> : <AdminOrderList />
}

function AdminOrderList() {
  const [status, setStatus] = useState('')
  const [orders, setOrders] = useState([])
  const [nextBefore, setNextBefore] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    api.getAdminOrders(buildAdminOrderQuery({ status })).then((result) => {
      if (!active) return
      setOrders(result.orders || [])
      setNextBefore(result.nextBefore || null)
    }).catch((cause) => {
      if (active) setError(adminErrorMessage(cause))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [status])

  async function loadMore() {
    if (!nextBefore || loadingMore) return
    setLoadingMore(true)
    setError('')
    try {
      const result = await api.getAdminOrders(buildAdminOrderQuery({ status, before: nextBefore }))
      setOrders((current) => [...current, ...(result.orders || [])])
      setNextBefore(result.nextBefore || null)
    } catch (cause) {
      setError(adminErrorMessage(cause))
    } finally {
      setLoadingMore(false)
    }
  }

  function changeStatus(value) {
    setLoading(true)
    setError('')
    setStatus(value)
  }

  return (
    <section>
      <div className="admin-toolbar">
        <div><p className="admin-eyebrow">Operations</p><h1>Orders</h1></div>
        <div className="admin-filter">
          <label>Status
            <select value={status} onChange={(event) => changeStatus(event.target.value)}>
              <option value="">All statuses</option>
              {ORDER_STATUSES.map((value) => <option key={value} value={value}>{adminStatusLabel(value)}</option>)}
            </select>
          </label>
        </div>
      </div>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {loading ? <p className="admin-loading" role="status">Loading orders…</p> : orders.length === 0
        ? <p role="status">No orders found.</p>
        : <div className="admin-list">
          {orders.map((order) => <AdminOrderRow key={order.orderId} order={order} />)}
        </div>}
      {nextBefore && !loading && (
        <div className="admin-pagination">
          <button className="admin-button" type="button" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </section>
  )
}

function AdminOrderRow({ order }) {
  return (
    <article className="admin-card admin-row">
      <h2><a href={`/admin/orders/${encodeURIComponent(order.orderId)}`}>{order.listing?.title || 'Untitled listing'}</a></h2>
      <p><strong>Status:</strong> {adminStatusLabel(order.status)} · <strong>Payment:</strong> {adminStatusLabel(order.paymentStatus)}</p>
      <p><strong>Amounts:</strong> {formatAdminAmount(order.amounts?.itemPrice, order.currency)} item · {formatAdminAmount(order.amounts?.deliveryFee, order.currency)} delivery · {formatAdminAmount(order.amounts?.total, order.currency)} total</p>
      <p><strong>Flags:</strong> {order.hasOpenDispute ? 'Open dispute' : 'No open dispute'} · {order.hasUnresolvedException ? 'Unresolved exception' : 'No unresolved exception'}</p>
      <p><strong>Created:</strong> {formatAdminDate(order.createdAt)} · <strong>Funded:</strong> {formatAdminDate(order.fundedAt)} · <strong>Handover deadline:</strong> {formatAdminDate(order.handoverDeadlineAt)} · <strong>Handed over:</strong> {formatAdminDate(order.handedOverAt)} · <strong>Delivered:</strong> {formatAdminDate(order.deliveredAt)}</p>
    </article>
  )
}

function AdminOrderDetail({ orderId }) {
  const [order, setOrder] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [payoutReceipt, setPayoutReceipt] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.getAdminOrder(orderId)
      setOrder(result)
      return result
    } catch (cause) {
      setError(adminErrorMessage(cause))
      return null
    } finally {
      setLoading(false)
    }
  }, [orderId])

  useEffect(() => {
    let active = true
    api.getAdminOrder(orderId).then((result) => {
      if (active) setOrder(result)
    }).catch((cause) => {
      if (active) setError(adminErrorMessage(cause))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [orderId])

  const eligibility = useMemo(() => orderActionEligibility(order || {}, {
    markHandover: true,
    markDelivered: true,
    releasePayout: true,
  }), [order])

  if (loading && !order) return <p className="admin-loading" role="status">Loading order…</p>
  if (error && !order) return <p className="admin-error" role="alert">{error}</p>
  if (!order) return null

  return (
    <section>
      <p className="admin-eyebrow">Order details</p>
      <p><a href="/admin/orders">← Orders</a></p>
      <h1>{order.listing?.title || 'Order'}</h1>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {notice && <p className="admin-notice" role="status">{notice}</p>}
      {loading && <p role="status">Refreshing order from the server…</p>}
      <section className="admin-card">
        <h2>Order summary</h2>
        <dl className="admin-data-grid">
          <div><dt>Order</dt><dd>{order.orderId}</dd></div>
          <div><dt>Status</dt><dd>{adminStatusLabel(order.status)}</dd></div>
          <div><dt>Payment status</dt><dd>{adminStatusLabel(order.paymentStatus)}</dd></div>
          <div><dt>Created</dt><dd>{formatAdminDate(order.createdAt)}</dd></div>
          <div><dt>Funded</dt><dd>{formatAdminDate(order.fundedAt)}</dd></div>
          <div><dt>Handover deadline</dt><dd>{formatAdminDate(order.handoverDeadlineAt)}</dd></div>
          <div><dt>Courier pickup</dt><dd>{formatAdminDate(order.courierPickupAt)}</dd></div>
          <div><dt>Handover recorded</dt><dd>{formatAdminDate(order.handoverRecordedAt)}</dd></div>
          <div><dt>Handed over</dt><dd>{formatAdminDate(order.handedOverAt)}</dd></div>
          <div><dt>Delivered</dt><dd>{formatAdminDate(order.deliveredAt)}</dd></div>
          <div><dt>Tracking number</dt><dd>{order.trackingNumber || '—'}</dd></div>
          <div><dt>Payment amount</dt><dd>{formatAdminAmount(order.payment?.amount, order.payment?.currency || order.currency)}</dd></div>
        </dl>
      </section>

      <section className="admin-card">
        <h2>Parties and delivery address</h2>
        <dl className="admin-data-grid">
          <div><dt>Buyer</dt><dd>{order.buyer?.displayName || '—'}</dd></div>
          <div><dt>Seller</dt><dd>{order.seller?.displayName || '—'}</dd></div>
          <div><dt>Recipient</dt><dd>{order.deliveryAddress?.recipientName || '—'}</dd></div>
          <div><dt>Phone</dt><dd>{order.deliveryAddress?.phone || '—'}</dd></div>
          <div><dt>City</dt><dd>{order.deliveryAddress?.city || '—'}</dd></div>
          <div><dt>Address</dt><dd>{[order.deliveryAddress?.addressLine1, order.deliveryAddress?.addressLine2, order.deliveryAddress?.postalCode].filter(Boolean).join(', ') || '—'}</dd></div>
        </dl>
      </section>

      <section className="admin-card">
        <h2>Amounts and refunds</h2>
        <dl className="admin-data-grid">
          <div><dt>Item price</dt><dd>{formatAdminAmount(order.amounts?.itemPrice, order.payment?.currency || order.currency)}</dd></div>
          <div><dt>Delivery fee</dt><dd>{formatAdminAmount(order.amounts?.deliveryFee, order.payment?.currency || order.currency)}</dd></div>
          <div><dt>Total</dt><dd>{formatAdminAmount(order.amounts?.total, order.payment?.currency || order.currency)}</dd></div>
          <div><dt>Refunds</dt><dd>{order.refunds?.length ? order.refunds.map((refund) => `${refund.status || 'Refund'} ${refund.amount || ''}`).join('; ') : 'None recorded'}</dd></div>
        </dl>
      </section>

      <section className="admin-card">
        <h2>Payout hold</h2>
        <dl className="admin-data-grid">
          <div><dt>State</dt><dd>{adminStatusLabel(order.payoutHold?.state)}</dd></div>
          <div><dt>Hold started</dt><dd>{formatAdminDate(order.payoutHold?.holdStartedAt)}</dd></div>
          <div><dt>Hold window</dt><dd>{order.payoutHold?.holdWindowDays ?? '—'} days</dd></div>
          <div><dt>Complaint window</dt><dd>{order.payoutHold?.complaintWindowDays ?? '—'} days</dd></div>
          <div><dt>Earliest release</dt><dd>{formatAdminDate(order.payoutHold?.earliestReleaseAt)}</dd></div>
        </dl>
        <p>{eligibility.payout.hint || payoutReleaseMessage(order.payoutHold)}</p>
        {order.hasOpenDispute && <p className="admin-warning">An open dispute pauses payout release.</p>}
      </section>

      <section className="admin-card">
        <h2>Disputes and exceptions</h2>
        <h3>Disputes</h3>
        {order.disputes?.length
          ? <ul>{order.disputes.map((dispute) => <li key={dispute.id}><a href="/admin/disputes">{adminStatusLabel(dispute.status)} dispute</a> · {formatAdminDate(dispute.createdAt)}</li>)}</ul>
          : <p>No disputes recorded.</p>}
        <h3>Exceptions</h3>
        {order.exceptions?.length
          ? <ul>{order.exceptions.map((exception) => <li key={exception.id}><a href="/admin/exceptions">{adminStatusLabel(exception.kind)} · {exception.resolvedAt ? 'Resolved' : 'Unresolved'}</a> · {formatAdminDate(exception.recordedAt)}</li>)}</ul>
          : <p>No delivery exceptions recorded.</p>}
      </section>

      {eligibility.handover.allowed && <HandoverForm order={order} onSuccess={refresh} onError={setError} onNotice={setNotice} />}
      {eligibility.delivered.allowed && <DeliveredForm order={order} onSuccess={refresh} onError={setError} onNotice={setNotice} />}
      {eligibility.payout.allowed && (
        <PayoutForm
          order={order}
          onSuccess={async (result) => {
            setPayoutReceipt(result)
            await refresh()
            setNotice('Manual payout recorded. Order details were refreshed from the server.')
          }}
          onError={setError}
        />
      )}
      {payoutReceipt?.payout && (
        <section className="admin-card" role="status">
          <h2>Recorded payout amounts</h2>
          <p>Seller net: {formatAdminAmount(payoutReceipt.payout.sellerNetAmount, payoutReceipt.payout.currency)}</p>
          <p>Commission: {formatAdminAmount(payoutReceipt.payout.commissionAmount, payoutReceipt.payout.currency)}</p>
        </section>
      )}
    </section>
  )
}

function HandoverForm({ order, onSuccess, onError, onNotice }) {
  const [pending, setPending] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  async function submit(event) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const input = {
      courierPickupAt: String(form.get('courierPickupAt') || ''),
      handoverConfirmationNote: String(form.get('handoverConfirmationNote') || ''),
      trackingNumber: String(form.get('trackingNumber') || ''),
      fundedAt: order.fundedAt,
    }
    const validation = validateHandoverForm(input)
    if (validation) {
      onError(validation)
      return
    }
    if (!confirmed) {
      onError('Confirm that the handover information is accurate.')
      return
    }
    setPending(true)
    onError('')
    onNotice('')
    try {
      await api.recordAdminHandover(order.orderId, {
        status: 'handed_to_delivery',
        courierPickupAt: localDateTimeToIsoWithOffset(input.courierPickupAt),
        handoverConfirmationNote: input.handoverConfirmationNote.trim(),
        ...(input.trackingNumber.trim() ? { trackingNumber: input.trackingNumber.trim() } : {}),
      })
      onNotice('Handover recorded. Order details were refreshed from the server.')
      await onSuccess()
    } catch (cause) {
      const message = adminHandoverErrorMessage(cause)
      if (isRecordedHandoverConflict(cause)) {
        const refreshed = await onSuccess()
        onError(refreshed ? message : `${message} The order details could not be refreshed.`)
      } else {
        onError(message)
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="admin-card">
      <h2>Record handover</h2>
      <form className="admin-form" onSubmit={submit}>
        <label>Courier pickup time
          <input name="courierPickupAt" type="datetime-local" required />
        </label>
        <label>Handover confirmation note
          <textarea name="handoverConfirmationNote" required minLength="3" maxLength="500" />
        </label>
        <label>Tracking number (optional)
          <input name="trackingNumber" maxLength="100" />
        </label>
        <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I confirm this handover information is accurate.</label>
        <button className="admin-button admin-button-primary" type="submit" disabled={pending || !confirmed}>
          {pending ? 'Recording…' : 'Record handover'}
        </button>
      </form>
    </section>
  )
}

function DeliveredForm({ order, onSuccess, onError, onNotice }) {
  const [pending, setPending] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  async function submit(event) {
    event.preventDefault()
    const note = String(new FormData(event.currentTarget).get('note') || '').trim()
    if (note.length < 1 || note.length > 500) {
      onError('Delivery note must be 1 to 500 characters.')
      return
    }
    if (!confirmed) {
      onError('Confirm that delivery has been verified.')
      return
    }
    setPending(true)
    onError('')
    onNotice('')
    try {
      await api.markAdminOrderDelivered(order.orderId, { note })
      onNotice('Delivery recorded. Order details were refreshed from the server.')
      await onSuccess()
    } catch (cause) {
      onError(adminErrorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="admin-card">
      <h2>Mark delivered</h2>
      <form className="admin-form" onSubmit={submit}>
        <label>Delivery note<textarea name="note" required minLength="1" maxLength="500" /></label>
        <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I confirm the delivery status is accurate.</label>
        <button className="admin-button admin-button-primary" type="submit" disabled={pending || !confirmed}>
          {pending ? 'Recording…' : 'Mark delivered'}
        </button>
      </form>
    </section>
  )
}

function PayoutForm({ order, onSuccess, onError }) {
  const [pending, setPending] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  async function submit(event) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const input = {
      payoutReference: String(form.get('payoutReference') || ''),
      note: String(form.get('note') || ''),
    }
    const validation = validatePayoutForm(input)
    if (validation) {
      onError(validation)
      return
    }
    if (!confirmed) {
      onError('Confirm that this manual payout has been made.')
      return
    }
    setPending(true)
    onError('')
    try {
      const result = await api.releaseAdminOrderPayout(order.orderId, {
        payoutReference: input.payoutReference.trim(),
        note: input.note.trim(),
      })
      await onSuccess(result)
    } catch (cause) {
      onError(adminErrorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="admin-card">
      <h2>Release payout</h2>
      <p className="admin-warning">This records a manual payout and cannot be undone. Confirm the transfer has already been made before continuing.</p>
      <form className="admin-form" onSubmit={submit}>
        <label>Payout reference<input name="payoutReference" required minLength="3" maxLength="100" /></label>
        <label>Note<textarea name="note" required minLength="3" maxLength="500" /></label>
        <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I confirm this manual payout is complete and the reference is correct.</label>
        <button className="admin-button admin-button-primary" type="submit" disabled={pending || !confirmed}>
          {pending ? 'Recording payout…' : 'Record payout release'}
        </button>
      </form>
    </section>
  )
}
