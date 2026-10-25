export const SEO_TITLE_LIMIT = 60
export const SEO_DESCRIPTION_LIMIT = 155

export function getSeoValidation({ title = '', description = '', condition = '', required = false } = {}) {
  const issues = []
  if (required && !title.trim()) issues.push('Write an SEO title.')
  if (required && !description.trim()) issues.push('Write an SEO description.')
  if (title.length > SEO_TITLE_LIMIT) issues.push(`SEO title must be ${SEO_TITLE_LIMIT} characters or fewer.`)
  if (description.length > SEO_DESCRIPTION_LIMIT) issues.push(`SEO description must be ${SEO_DESCRIPTION_LIMIT} characters or fewer.`)
  if (condition === 'replica') {
    if (!/\breplica\b/i.test(title)) issues.push('Replica listings must include "Replica" in the SEO title.')
    if (/\b(?:original|authentic)\b/i.test(`${title} ${description}`)) {
      issues.push('Replica listing SEO text cannot call the item original or authentic.')
    }
  }
  return issues
}

export function getMessageErrorMessage(error) {
  const serverMessage = error?.payload?.error
  if (typeof serverMessage === 'string' && /cannot contain phone numbers, email addresses, or links/i.test(serverMessage)) {
    return 'Contact details are blocked. Messages cannot contain phone numbers, email addresses, or links. Please keep contact on Poshaak.'
  }
  return serverMessage || error?.message || 'The message could not be sent.'
}
