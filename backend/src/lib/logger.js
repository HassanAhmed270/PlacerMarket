const DENIED_FIELDS = new Set(['password', 'password_hash', 'token', 'refresh_token', 'step_up_grant', 'authorization', 'cookie', 'secret', 'email', 'phone', 'address', 'body', 'query', 'params', 'grant', 'ip', 'user_agent', 'name', 'full_name']);
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
function logLevel(env = process.env) {
  const raw = env.LOG_LEVEL;
  if (!raw) return 'info';
  const value = String(raw).toLowerCase();
  if (!LEVELS.has(value)) {
    if (env.NODE_ENV === 'production') throw new Error('Configuration error: LOG_LEVEL must be debug, info, warn, or error.');
    return 'info';
  }
  return value;
}

function sanitize(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[redacted]';
  seen.add(value);
  if (Buffer.isBuffer(value)) return '[redacted]';
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = DENIED_FIELDS.has(key.toLowerCase()) ? '[redacted]' : sanitize(child, seen);
  }
  return output;
}

function safeFields(fields) {
  return sanitize(fields || {});
}

function emit(level, msg, fields = {}) {
  const threshold = { debug: 10, info: 20, warn: 30, error: 40 }[logLevel()];
  const levelRank = { debug: 10, info: 20, warn: 30, error: 40 }[level] || 20;
  if (levelRank < threshold) return;
  const safe = safeFields(fields);
  const entry = { ...safe, level, time: new Date().toISOString(), msg };
  if (process.env.NODE_ENV === 'production') {
    const stream = level === 'error' || level === 'warn' ? console.error : console.log;
    stream(JSON.stringify(entry));
  } else {
    const details = Object.keys(fields).length ? ` ${JSON.stringify(safeFields(fields))}` : '';
    const text = `${level.toUpperCase()} ${entry.time} ${msg}${details}`;
    if (level === 'error' || level === 'warn') console.error(text);
    else console.log(text);
  }
}

const logger = Object.freeze({
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
});

module.exports = { logger, safeFields, sanitize, logLevel };
