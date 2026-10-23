const { Router } = require('express');

const router = Router();

router.use('/users', require('./users.routes'));
router.use('/catalog', require('./catalog.routes'));
router.use('/listings', require('./listings.routes'));
router.use('/media', require('./media.routes'));
router.use('/discovery', require('./discovery.routes'));
router.use('/negotiation', require('./negotiation.routes'));
router.use('/orders', require('./orders.routes'));
router.use('/payments', require('./payments.routes'));
router.use('/delivery', require('./delivery.routes'));
router.use('/disputes', require('./disputes.routes'));
router.use('/payout', require('./payout.routes'));
router.use('/settlement', require('./settlement.routes'));
router.use('/notifications', require('./notifications.routes'));
router.use('/admin', require('./admin.routes'));

module.exports = router;
