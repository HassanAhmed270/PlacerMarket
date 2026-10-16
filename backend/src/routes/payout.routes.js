const { Router } = require('express');
const payout = require('../modules/payout.service');
const { requirePermission } = require('../middleware/auth');

const router = Router();

// FR-45h/FR-44: combined HELD + dispute view. No specific 'payout.review'
// permission defined yet in lib/roles.js — using 'dispute.review' as the
// closest existing gate since FR-44 already combines the two views.
router.get('/held-orders', requirePermission('dispute.review'), async (req, res) => {
  res.json(await payout.getHeldOrdersWithDisputeStatus());
});

// FR-45e: Admin-only in practice since force-release isn't in the
// Moderator/Ops allowed-actions list (lib/roles.js) — 'user.suspend' is
// reused here ONLY as a stand-in Admin-only gate; add a dedicated
// 'payout.force_release' permission before this goes further.
router.post('/orders/:id/force-release', requirePermission('user.suspend'), async (req, res) => {
  res.json(await payout.forceReleasePayoutEarly(req.params.id, { adminId: req.user.id, reasonNote: req.body.reasonNote })); // FR-45e, FR-45f
});

// FR-45d: intended to be triggered by a cron/worker, not a public route.
// Exposed here ONLY for manual/admin-triggered testing during development.
router.post('/run-scheduled-release', requirePermission('user.suspend'), async (req, res) => {
  res.json(await payout.checkAndReleaseDuePayouts());
});

module.exports = router;
