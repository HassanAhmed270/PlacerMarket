const { Router } = require('express');
const catalog = require('../modules/catalog.service');
const listings = require('../modules/listings.service');
const { requireAuth, requirePermission } = require('../middleware/auth');
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

router.get('/attributes/:type', async (req, res) => {
  res.json(await catalog.listManagedAttributeValues(req.params.type)); // FR-15b
});

router.get('/sub-categories/:id/measurement-fields', async (req, res) => {
  res.json(await catalog.getMeasurementFieldDefs(req.params.id)); // FR-15a (definitions side)
});

router.post('/main-categories', requireAuth, requirePermission('catalog.manage'), async (req, res) => {
  res.status(201).json(await catalog.createMainCategory(req.body, req.user.id)); // FR-12
});

router.get('/sub-categories/:id/measurement-fields/admin', requireAuth, requirePermission('catalog.manage'), async (req, res) => {
  res.json(await catalog.getMeasurementFieldDefs(req.params.id, { includeInactive: true })); // FR-15a
});

router.put('/sub-categories/:id/measurement-fields', requireAuth, requirePermission('catalog.manage'), async (req, res) => {
  if (!req.body || Object.keys(req.body).some((key) => key !== 'fieldDefs') || !Array.isArray(req.body.fieldDefs)) {
    throw new ValidationError('fieldDefs must be an array');
  }
  res.json(await catalog.setMeasurementFieldDefs(
    req.params.id, req.body.fieldDefs, req.user.id, listings.getReferencedMeasurementDefinitionIds
  )); // FR-15a
});

router.post('/attributes/:type', requireAuth, requirePermission('catalog.manage'), async (req, res) => {
  res.status(201).json(await catalog.createManagedAttributeValue(req.params.type, req.body, req.user.id)); // FR-15b
});

router.get('/attribute-approval-queue', requireAuth, requirePermission('catalog.attribute.review'), async (_req, res) => {
  res.json(await catalog.getManagedAttributeApprovalQueue()); // FR-15b
});

router.post('/attributes/:id/approve', requireAuth, requirePermission('catalog.attribute.review'), async (req, res) => {
  res.json(await catalog.approveManagedAttributeValue(req.params.id, req.user.id)); // FR-15b
});

router.post('/attributes/:id/reject', requireAuth, requirePermission('catalog.attribute.review'), async (req, res) => {
  res.json(await catalog.rejectManagedAttributeValue(req.params.id, req.user.id, req.body.reason)); // FR-15b
});

module.exports = router;
