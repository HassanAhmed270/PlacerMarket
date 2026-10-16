/**
 * app.js
 *
 * NOTE: no session/auth middleware is wired in here yet — req.user is not
 * populated anywhere in this scaffold. See users.service.js's authenticate()
 * TODO and middleware/auth.js's header comment. Add the real session layer
 * (cookie session vs JWT — not yet decided) BEFORE these routes see traffic.
 */

const express = require('express');
const routes = require('./routes');
const errorHandler = require('./middleware/errorHandler');

// modules/notifications.service.js registers its eventBus listeners as a
// side effect of being required — requiring the routes above already pulls
// it in transitively, but requiring it explicitly here makes that
// non-obvious dependency visible.
require('./modules/notifications.service');

const app = express();
app.use(express.json());
// Express 5 leaves req.body undefined when a request has no body (Express 4 gave {}); handlers read req.body.x.
app.use((req, _res, next) => {
  req.body ??= {};
  next();
});
app.use('/api', routes);
app.use(errorHandler); // must be mounted LAST

module.exports = app;
