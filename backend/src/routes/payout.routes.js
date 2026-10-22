const { Router } = require('express');
const payout = require('../modules/payout.service');
const users = require('../modules/users.service');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { ValidationError } = require('../lib/errors');

const router = Router();

// FR-45h/FR-44: combined HELD + dispute view. No specific 'payout.review'
// permission defined yet in lib/roles.js — using 'dispute.review' as the
// closest existing gate since FR-44 already combines the two views.
router.get('/held-orders', requirePermission('dispute.review'), async (req, res) => {
  res.json(await payout.getHeldOrdersWithDisputeStatus());
});

// FR-45e / FR-83f: force-release needs its own Admin-only permission and a
// session-bound authenticator step-up grant.
router.post('/orders/:id/force-release', requireAuth, requirePermission('payout.force_release'), async (req, res) => {
  const grant = req.get('x-step-up-grant');
  if (!grant || Object.keys(req.body).some((key) => key !== 'reasonNote') ||
      typeof req.body.reasonNote !== 'string' || !req.body.reasonNote.trim() || req.body.reasonNote.trim().length > 500) {
    throw new ValidationError('A step-up grant and short reason are required.');
  }
  await users.consumeStepUpGrant(req.user.id, req.authSessionId, 'payout.force_release', grant);
  res.json(await payout.forceReleasePayoutEarly(req.params.id, { adminId: req.user.id, reasonNote: req.body.reasonNote })); // FR-45e, FR-45f
});

// FR-45d: intended to be triggered by a cron/worker, not a public route.
// Exposed here ONLY for manual/admin-triggered testing during development.
router.post('/run-scheduled-release', requirePermission('user.suspend'), async (req, res) => {
  res.json(await payout.checkAndReleaseDuePayouts());
});

module.exports = router;
