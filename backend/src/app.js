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
const { NotFoundError } = require('./lib/errors');

// modules/notifications.service.js registers its eventBus listeners as a
// side effect of being required — requiring the routes above already pulls
// it in transitively, but requiring it explicitly here makes that
// non-obvious dependency visible.
require('./modules/notifications.service');

const app = express();
app.use(requestId);
app.use(helmet());
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
app.use(errorHandler); // must be mounted LAST

module.exports = app;
