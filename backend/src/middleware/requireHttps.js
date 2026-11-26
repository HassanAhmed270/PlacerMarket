function requireHttps(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();
  if (req.path === '/healthz' || req.path === '/readyz') return next();
  if (req.secure === true) return next();
  return res.status(400).json({ error: 'HTTPS required' });
}

module.exports = requireHttps;
