/**
 * app.js
 *
 * FR-84 protected routes verify short-lived bearer access tokens through
 * middleware/auth.js. Credential issuance remains gated by open requirements.
 */

const express = require('express');
const helmet = require('helmet');
const routes = require('./routes');
const errorHandler = require('./middleware/errorHandler');
const requestId = require('./middleware/requestId');
const { createCorsMiddleware } = require('./middleware/cors');
const { cachePolicy, pageCachePolicy } = require('./middleware/cachePolicy');
const pageSnapshots = require('./modules/pageSnapshots.service');
const { NotFoundError } = require('./lib/errors');

// modules/notifications.service.js registers its eventBus listeners as a
// side effect of being required — requiring the routes above already pulls
// it in transitively, but requiring it explicitly here makes that
// non-obvious dependency visible.
require('./modules/notifications.service');

const app = express();
app.use(requestId);
app.use(helmet());
app.use('/api', cachePolicy);
app.use(createCorsMiddleware());
app.use(express.json({ limit: '1mb' }));
app.use('/api/media/listings', express.raw({ type: 'application/octet-stream', limit: '5mb' }));
// Express 5 leaves req.body undefined when a request has no body (Express 4 gave {}); handlers read req.body.x.
app.use((req, _res, next) => {
  req.body ??= {};
  next();
});
app.use('/api', routes);
if (process.env.NODE_ENV !== 'production' && process.env.DEV_FAKES === '1') {
  app.use('/api/dev', require('./routes/dev.routes'));
}
app.use('/api', (_req, _res, next) => next(new NotFoundError('route', 'unknown')));
app.use(async (req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method) || req.path.startsWith('/api/')) return next();
  const snapshotPath = req.path === '/' || req.path === '/search' || req.path === '/sitemap.xml'
    || req.path === '/robots.txt' || req.path.startsWith('/category/') || req.path.startsWith('/listing/');
  if (!snapshotPath) return next();
  const searchParams = new URLSearchParams(req.originalUrl.split('?')[1] || '');
  const filtered = pageSnapshots.isNoindex({ pathname: req.path, searchParams });
  let snapshot = await pageSnapshots.getSnapshot(req.path);
  if (!snapshot && req.path.startsWith('/listing/')) {
    const canonicalPath = await pageSnapshots.getCanonicalListingPath(req.path.slice('/listing/'.length));
    if (canonicalPath && canonicalPath !== req.path) return res.redirect(301, canonicalPath);
  }
  if (!snapshot && req.path === '/search') {
    snapshot = {
      html: pageSnapshots.renderCollectionPage({
        title: 'Search | Poshaak',
        description: 'Search Pakistani fashion.',
        path: '/search',
        items: [],
        baseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
        pageType: 'search',
        noindex: true,
      }),
      status_code: 200,
      noindex: true,
    };
  }
  if (!snapshot) return next();

  pageCachePolicy(req, res, () => {});
  if (snapshot.noindex || filtered) {
    res.set('X-Robots-Tag', 'noindex, follow');
    if (filtered && !snapshot.noindex) {
      snapshot.html = snapshot.html.replace(
        '<meta name="robots" content="index,follow">',
        '<meta name="robots" content="noindex,follow">'
      );
    }
  }
  if (req.path === '/sitemap.xml') res.type('application/xml');
  else if (req.path === '/robots.txt') res.type('text/plain');
  else res.type('html');
  return res.status(snapshot.status_code).send(snapshot.html);
});
app.use(errorHandler); // must be mounted LAST

module.exports = app;
