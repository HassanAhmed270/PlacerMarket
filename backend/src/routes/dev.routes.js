const { Router } = require('express');
const { readDevEmailOutbox, clearDevEmailOutbox } = require('../lib/adapters/devEmailOutbox');
const { ValidationError } = require('../lib/errors');

const router = Router();

router.get('/outbox', async (req, res) => {
  const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ValidationError('limit must be an integer from 1 to 500.');
  res.set('Cache-Control', 'no-store').json(await readDevEmailOutbox({ limit }));
});

router.delete('/outbox', async (_req, res) => {
  await clearDevEmailOutbox();
  res.status(204).end();
});

module.exports = router;
