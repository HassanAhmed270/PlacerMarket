import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import {
  adminErrorMessage,
  formatAdminDate,
} from './lib/admin.js'
import {
  formatPkr,
  payoutStatusLabel,
  validateExportFilters,
} from './lib/payouts.js'

const INITIAL_EXPORT_FILTERS = { status: '', from: '', to: '' }

export default function AdminSellerPayouts() {
  const [payouts, setPayouts] = useState([])
  const [status, setStatus] = useState('')
  const [limit, setLimit] = useState(20)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [pendingExport, setPendingExport] = useState(false)
  const [error, setError] = useState('')
  const [listError, setListError] = useState('')
  const [notice, setNotice] = useState('')
  const [reload, setReload] = useState(0)
  const [exportFilters, setExportFilters] = useState(INITIAL_EXPORT_FILTERS)
  const [authenticatorCode, setAuthenticatorCode] = useState('')

  useEffect(() => {
    let active = true
    api.getAdminSellerPayouts({ status, limit }).then((result) => {
      if (active) setPayouts(result.payouts || [])
    }).catch((cause) => {
      if (active) setListError(adminErrorMessage(cause))
    }).finally(() => {
      if (active) {
        setLoading(false)
        setLoadingMore(false)
      }
    })
    return () => { active = false }
  }, [status, limit, reload])

  function changeStatus(value) {
    setLoading(true)
    setStatus(value)
    setLimit(20)
    setListError('')
  }

  function loadMore() {
    if (loading || loadingMore || listError || limit >= 100 || payouts.length < limit) return
    setLoadingMore(true)
    setLoading(true)
    setLimit((current) => Math.min(current + 20, 100))
  }

  function setExportFilter(name, value) {
    setExportFilters((current) => ({ ...current, [name]: value }))
  }

  async function exportCsv(event) {
    event.preventDefault()
    const validation = validateExportFilters(exportFilters)
    if (validation) {
      setError(validation)
      return
    }
    if (!authenticatorCode.trim()) {
      setError('Enter your authenticator code to export payouts.')
      return
    }

    setPendingExport(true)
    setError('')
    setNotice('')
    try {
      const stepUp = await api.createStepUpGrant('payout.export', authenticatorCode)
      const csv = await api.exportAdminSellerPayouts({
        ...exportFilters,
        stepUpGrant: stepUp.grant,
      })
      const objectUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      anchor.download = 'payouts.csv'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
      setNotice('Payout CSV downloaded.')
    } catch (cause) {
      setError(adminErrorMessage(cause))
    } finally {
      setAuthenticatorCode('')
      setPendingExport(false)
    }
  }

  return (
    <section>
      <div className="admin-toolbar">
        <div><p className="admin-eyebrow">Payments</p><h1>Seller payouts</h1></div>
        <label className="admin-payout-status-filter">Filter by status
          <select value={status} onChange={(event) => changeStatus(event.target.value)}>
            <option value="">All statuses</option>
            <option value="initiated">Initiated</option>
            <option value="paid">Paid</option>
            <option value="failed">Failed</option>
          </select>
        </label>
      </div>
      {listError && <p className="admin-error" role="alert">{listError}</p>}
      {error && <p className="admin-error" role="alert">{error}</p>}
      {notice && <p className="admin-notice" role="status">{notice}</p>}
      {loading ? <p role="status">Loading seller payouts…</p> : listError ? null : payouts.length === 0
        ? <p role="status">No seller payouts found.</p>
        : <div className="admin-table-wrap">
          <table className="admin-payout-table">
            <caption className="admin-visually-hidden">Seller payout records</caption>
            <thead>
              <tr>
                <th scope="col">Payout</th>
                <th scope="col">Order</th>
                <th scope="col">Status</th>
                <th scope="col">Amount</th>
                <th scope="col">Attempt</th>
                <th scope="col">Approval</th>
                <th scope="col">Initiated</th>
              </tr>
            </thead>
            <tbody>
              {payouts.map((payout) => (
                <tr key={payout.id}>
                  <td><a href={`/admin/seller-payouts/${encodeURIComponent(payout.id)}`}>{payout.id}</a></td>
                  <td><a href={`/admin/orders/${encodeURIComponent(payout.orderId)}`}>{payout.orderId}</a></td>
                  <td>{payoutStatusLabel(payout.status)}</td>
                  <td>{formatPkr(payout.amount)}</td>
                  <td>{payout.attempt}</td>
                  <td>{payout.requiresApproval && !payout.approvedBy
                    ? <span className="admin-payout-badge">Needs approval</span>
                    : payout.approvedBy ? 'Approved' : 'Not required'}</td>
                  <td>{formatAdminDate(payout.initiatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>}
      {!loading && !listError && payouts.length >= limit && limit < 100 && (
        <div className="admin-pagination">
          <button className="admin-button" type="button" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
      {!loading && listError && (
        <div className="admin-pagination">
          <button className="admin-button" type="button" onClick={() => {
            setLoading(true)
            setListError('')
            setReload((current) => current + 1)
          }}>Retry payout list</button>
        </div>
      )}

      <section className="admin-card admin-payout-export" aria-labelledby="payout-export-title">
        <h2 id="payout-export-title">Export payout CSV</h2>
        <p>Exports are limited to 5,000 rows and require a fresh authenticator check.</p>
        <form className="admin-form" onSubmit={exportCsv}>
          <div className="admin-payout-export-filters">
            <label>Status
              <select value={exportFilters.status} onChange={(event) => setExportFilter('status', event.target.value)}>
                <option value="">All statuses</option>
                <option value="initiated">Initiated</option>
                <option value="paid">Paid</option>
                <option value="failed">Failed</option>
              </select>
            </label>
            <label>From
              <input type="date" value={exportFilters.from} onChange={(event) => setExportFilter('from', event.target.value)} />
            </label>
            <label>To
              <input type="date" value={exportFilters.to} onChange={(event) => setExportFilter('to', event.target.value)} />
            </label>
          </div>
          <label>Authenticator code
            <input
              value={authenticatorCode}
              onChange={(event) => setAuthenticatorCode(event.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
            />
          </label>
          <button className="admin-button admin-button-primary" type="submit" disabled={pendingExport}>
            {pendingExport ? 'Exporting…' : 'Download CSV'}
          </button>
        </form>
      </section>
    </section>
  )
}
