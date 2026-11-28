const PAKISTAN_TIME_ZONE = 'Asia/Karachi';
const PKT_LABEL = 'PKT';

function formatPakistanDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid date/time value.');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PAKISTAN_TIME_ZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h12',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  for (const type of ['day', 'month', 'year', 'hour', 'minute', 'dayPeriod']) {
    if (!byType[type]) throw new Error(`Missing ${type} in Pakistan date/time parts.`);
  }
  return `${byType.day} ${byType.month} ${byType.year}, ${byType.hour}:${byType.minute} ${byType.dayPeriod.toUpperCase()} ${PKT_LABEL}`;
}

function formatPakistanDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid date/time value.');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PAKISTAN_TIME_ZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  for (const type of ['day', 'month', 'year']) {
    if (!byType[type]) throw new Error(`Missing ${type} in Pakistan date parts.`);
  }
  return `${byType.day} ${byType.month} ${byType.year}`;
}

module.exports = { PAKISTAN_TIME_ZONE, PKT_LABEL, formatPakistanDateTime, formatPakistanDate };
