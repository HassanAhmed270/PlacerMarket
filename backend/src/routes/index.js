const { Router } = require('express');

const router = Router();

const routeMounts = [
  ['/users', require('./users.routes')],
  ['/catalog', require('./catalog.routes')],
  ['/listings', require('./listings.routes')],
  ['/listings', require('./reservations.routes')],
  ['/media', require('./media.routes')],
  ['/discovery', require('./discovery.routes')],
  ['/negotiation', require('./negotiation.routes')],
  ['/orders', require('./orders.routes')],
  ['/payments', require('./payments.routes')],
  ['/delivery', require('./delivery.routes')],
  ['/disputes', require('./disputes.routes')],
  ['/payout', require('./payout.routes')],
  ['/settlement', require('./settlement.routes')],
  ['/notifications', require('./notifications.routes')],
  ['/admin', require('./admin.routes')],
];

for (const [mountPath, route] of routeMounts) router.use(mountPath, route);

module.exports = router;
module.exports.routeMounts = routeMounts;
