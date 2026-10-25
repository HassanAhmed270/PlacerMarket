const CACHE_POLICY_ALLOWLIST = Object.freeze([
  { method: 'GET', path: '/api/discovery/search', maxAge: 60 },
  { method: 'GET', path: '/api/discovery/filter', maxAge: 60 },
  { method: 'GET', path: '/api/discovery/suggestions', maxAge: 60 },
  { method: 'GET', path: '/api/discovery/vocabulary', maxAge: 60 },
  { method: 'GET', path: '/api/discovery/listings/:id', maxAge: 10 },
  { method: 'GET', path: '/api/discovery/listings/:id/status', maxAge: 10 },
  { method: 'GET', path: '/api/discovery/listings/:id/share-url', maxAge: 10 },
  {
    method: 'GET',
    path: '/api/media/images/:id/:variant/:hash.webp',
    cacheControl: 'private, no-store',
  },
]);

function routePattern(path) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/:[^/]+/g, '[^/]+')}/?$`);
}

function getCachePolicyRule(method, path) {
  return CACHE_POLICY_ALLOWLIST.find((rule) => (
    rule.method === method && routePattern(rule.path).test(path)
  ));
}

function cachePolicy(req, res, next) {
  const rule = getCachePolicyRule(req.method, req.originalUrl.split('?')[0]);
  res.set('Cache-Control', rule
    ? rule.cacheControl || `public, max-age=${rule.maxAge}`
    : 'private, no-store');
  next();
}

module.exports = { cachePolicy, CACHE_POLICY_ALLOWLIST, getCachePolicyRule };
