const PAKISTAN_TIME_ZONE = 'Asia/Karachi';
const PKT_LABEL = 'PKT';

function formatPakistanDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid date/time value.');
  const formatted = new Intl.DateTimeFormat('en-PK', {
    timeZone: PAKISTAN_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
  return `${formatted} ${PKT_LABEL}`;
}

function formatPakistanDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid date/time value.');
  return new Intl.DateTimeFormat('en-PK', {
    timeZone: PAKISTAN_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

module.exports = { PAKISTAN_TIME_ZONE, PKT_LABEL, formatPakistanDateTime, formatPakistanDate };
