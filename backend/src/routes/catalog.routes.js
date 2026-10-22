const { Router } = require('express');
const catalog = require('../modules/catalog.service');
const listings = require('../modules/listings.service');
const { requirePermission } = require('../middleware/auth');
const { ValidationError } = require('../lib/errors');

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

router.post('/main-categories', requirePermission('catalog.manage'), async (req, res) => {
  res.status(201).json(await catalog.createMainCategory(req.body, req.user.id)); // FR-12
});

router.get('/sub-categories/:id/measurement-fields/admin', requirePermission('catalog.manage'), async (req, res) => {
  res.json(await catalog.getMeasurementFieldDefs(req.params.id, { includeInactive: true })); // FR-15a
});

router.put('/sub-categories/:id/measurement-fields', requirePermission('catalog.manage'), async (req, res) => {
  if (!req.body || Object.keys(req.body).some((key) => key !== 'fieldDefs') || !Array.isArray(req.body.fieldDefs)) {
    throw new ValidationError('fieldDefs must be an array');
  }
  res.json(await catalog.setMeasurementFieldDefs(
    req.params.id, req.body.fieldDefs, req.user.id, listings.getReferencedMeasurementDefinitionIds
  )); // FR-15a
});

module.exports = router;
