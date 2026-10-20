const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PATCH', 'DELETE']);
const ALLOWED_HEADERS = new Set(['authorization', 'content-type']);

function parseAllowedOrigins(value = process.env.CORS_ORIGINS || '') {
  const origins = new Set();
  for (const entry of value.split(',')) {
    const origin = entry.trim();
    if (!origin) continue;
    if (origin === '*') throw new Error('CORS_ORIGINS must contain exact HTTP(S) origins without paths or wildcards.');
    let parsed;
    try { parsed = new URL(origin); }
    catch { throw new Error('CORS_ORIGINS must contain only valid HTTP(S) origins.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error('CORS_ORIGINS must contain exact HTTP(S) origins without paths or wildcards.');
    }
    origins.add(origin);
  }
  return origins;
}

function createCorsMiddleware({ allowedOrigins = parseAllowedOrigins() } = {}) {
  return function corsAllowlist(req, res, next) {
    const origin = req.get('origin');
    if (!origin) return next();
    if (!allowedOrigins.has(origin)) return res.status(403).json({ error: 'Origin is not allowed' });

    res.vary('Origin');
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
      const requestedMethod = req.get('access-control-request-method');
      const requestedHeaders = (req.get('access-control-request-headers') || '')
        .split(',').map((header) => header.trim().toLowerCase()).filter(Boolean);
      if ((requestedMethod && !ALLOWED_METHODS.has(requestedMethod)) ||
          requestedHeaders.some((header) => !ALLOWED_HEADERS.has(header))) {
        return res.status(403).end();
      }
      res.setHeader('Access-Control-Allow-Methods', [...ALLOWED_METHODS].join(', '));
      res.setHeader('Access-Control-Allow-Headers', [...ALLOWED_HEADERS].join(', '));
      res.setHeader('Access-Control-Max-Age', '600');
      return res.status(204).end();
    }
    next();
  };
}

module.exports = { parseAllowedOrigins, createCorsMiddleware };
