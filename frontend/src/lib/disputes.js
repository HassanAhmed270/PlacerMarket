export function getHttpsEvidenceHref(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

export function validateDisputeForm({ reasonText, evidenceUrls, maxEvidenceUrls } = {}) {
  const reason = typeof reasonText === 'string' ? reasonText.trim() : ''
  const values = Array.isArray(evidenceUrls)
    ? evidenceUrls.map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean)
    : []
  const errors = { reasonText: '', evidenceUrls: '' }

  if (!reason) errors.reasonText = 'Enter a reason for reporting this problem.'
  if (values.length === 0) errors.evidenceUrls = 'Add at least one HTTPS evidence URL.'
  else if (values.length > maxEvidenceUrls) {
    errors.evidenceUrls = `Add no more than ${maxEvidenceUrls} evidence URLs.`
  } else if (values.some((value) => !getHttpsEvidenceHref(value))) {
    errors.evidenceUrls = 'Evidence URLs must use HTTPS.'
  }

  return {
    valid: !errors.reasonText && !errors.evidenceUrls,
    errors,
    reasonText: reason,
    evidenceUrls: values,
  }
}
