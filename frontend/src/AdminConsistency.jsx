import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import { adminErrorMessage, formatAdminDate } from './lib/admin.js'

export default function AdminConsistency() {
  const [findings, setFindings] = useState([])
  const [nextCursor, setNextCursor] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    api.getAdminConsistencyFindings({ limit: 20 }).then((result) => {
      if (active) {
        setFindings(result.findings || [])
        setNextCursor(result.nextCursor || null)
      }
    }).catch((cause) => {
      if (active) setError(adminErrorMessage(cause))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [])

  async function loadMore() {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    setError('')
    try {
      const result = await api.getAdminConsistencyFindings({ limit: 20, cursor: nextCursor })
      setFindings((current) => [...current, ...(result.findings || [])])
      setNextCursor(result.nextCursor || null)
    } catch (cause) {
      setError(adminErrorMessage(cause))
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <section>
      <p className="admin-eyebrow">Read-only operations</p>
      <h1>Consistency findings</h1>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {loading ? <p role="status">Loading findings…</p> : findings.length === 0
        ? <p role="status">No consistency findings found.</p>
        : <div className="admin-list">
          {findings.map((finding) => (
            <article className="admin-card admin-row" key={finding.id}>
              <h2>{finding.checkName}</h2>
              <dl className="admin-data-grid">
                <div><dt>ID</dt><dd>{finding.id}</dd></div>
                <div><dt>Subject ID</dt><dd>{finding.subjectId}</dd></div>
                <div><dt>Business date</dt><dd>{finding.businessDate}</dd></div>
                <div><dt>Reason code</dt><dd>{finding.reasonCode}</dd></div>
                <div><dt>Created</dt><dd>{formatAdminDate(finding.createdAt)}</dd></div>
              </dl>
            </article>
          ))}
        </div>}
      {nextCursor && !loading && (
        <div className="admin-pagination">
          <button className="admin-button" type="button" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </section>
  )
}
