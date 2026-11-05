const { Router } = require('express');
const reservations = require('../modules/reservations.service');

const router = Router();

router.get('/delivery-cities', async (_req, res) => {
  res.json(await reservations.listActiveSupportedDeliveryCities());
});

module.exports = router;
