const { Router } = require('express');
const notifications = require('../modules/notifications.service');
const { requireAuth } = require('../middleware/auth');
const { NotFoundError } = require('../lib/errors');

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  res.json(await notifications.getUserNotifications(req.user.id, { unreadOnly: req.query.unreadOnly === 'true' })); // FR-51
});

router.patch('/:id/read', async (req, res) => {
  const updated = await notifications.markRead(req.params.id, req.user.id);
  if (!updated) throw new NotFoundError('notification', req.params.id);
  res.status(204).end();
});

module.exports = router;
