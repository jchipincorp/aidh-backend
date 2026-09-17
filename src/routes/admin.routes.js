// src/routes/admin.routes.js
const express = require('express');
const ctrl = require('../controllers/admin.controller');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncRoute } = require('./_helpers');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

router.post('/practitioners/:practitionerId/verify', asyncRoute(ctrl.verifyPractitioner));
router.post('/case-entries/:caseEntryId/review', asyncRoute(ctrl.reviewCaseEntry));
router.get('/audit-log', asyncRoute(ctrl.getAuditLog));

module.exports = router;
