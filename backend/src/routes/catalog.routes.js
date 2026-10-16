const { Router } = require('express');
const catalog = require('../modules/catalog.service');
const { requirePermission } = require('../middleware/auth');

const router = Router();

router.get('/main-categories', async (req, res) => {
  res.json(await catalog.listMainCategories()); // FR-11
});

router.get('/main-categories/:id/sub-categories', async (req, res) => {
  res.json(await catalog.listSubCategories(req.params.id)); // FR-11
});

router.get('/condition-types', (req, res) => {
  res.json(catalog.listConditionTypes()); // FR-13
});

router.get('/sub-categories/:id/measurement-fields', async (req, res) => {
  res.json(await catalog.getMeasurementFieldDefs(req.params.id)); // FR-15a (definitions side)
});

// Admin-only catalog management — no dedicated 'catalog.manage' permission
// defined yet in lib/roles.js; using Admin-only gate directly for now.
router.post('/main-categories', requirePermission('fee.configure'), async (req, res) => {
  // NOTE: reusing 'fee.configure' as a stand-in Admin-only gate is a shortcut —
  // add a proper 'catalog.manage' permission in lib/roles.js before relying on this.
  res.status(201).json(await catalog.createMainCategory(req.body, req.user.id)); // FR-12
});

module.exports = router;
