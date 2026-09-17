// src/routes/consent.routes.js
const express = require('express');
const ctrl = require('../controllers/consent.controller');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncRoute } = require('./_helpers');

const router = express.Router();

router.post('/grant', requireAuth, requireRole('subscriber'), asyncRoute(ctrl.grantConsent));
router.post('/:practitionerMatchId/revoke', requireAuth, requireRole('subscriber'), asyncRoute(ctrl.revokeConsent));

// Called by a practitioner's own client -- authenticated as a
// practitioner, but the actual data release is gated by the per-match
// consent token re-verified server-side inside the controller, not by
// this role check alone.
router.get('/:practitionerMatchId/data', requireAuth, requireRole('practitioner'), asyncRoute(ctrl.getDataForPractitioner));

module.exports = router;
