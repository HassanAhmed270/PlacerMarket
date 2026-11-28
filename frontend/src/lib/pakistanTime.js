export const PAKISTAN_TIME_ZONE = 'Asia/Karachi'
export const PKT_LABEL = 'PKT'

function dateFromValue(value) {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

export function formatPakistanDateTime(value) {
  const date = dateFromValue(value)
  if (!date) return '—'
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: PAKISTAN_TIME_ZONE,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hourCycle: 'h12',
    }).formatToParts(date)
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]))
    for (const type of ['day', 'month', 'year', 'hour', 'minute', 'dayPeriod']) {
      if (!byType[type]) return '—'
    }
    return `${byType.day} ${byType.month} ${byType.year}, ${byType.hour}:${byType.minute} ${byType.dayPeriod.toUpperCase()} ${PKT_LABEL}`
  } catch {
    return '—'
  }
}

export function formatPakistanDate(value) {
  const date = dateFromValue(value)
  if (!date) return '—'
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: PAKISTAN_TIME_ZONE,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).formatToParts(date)
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]))
    for (const type of ['day', 'month', 'year']) {
      if (!byType[type]) return '—'
    }
    return `${byType.day} ${byType.month} ${byType.year}`
  } catch {
    return '—'
  }
}
