// src/routes/consent.routes.js
const express = require('express');
const ctrl = require('../controllers/consent.controller');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncRoute } = require('./_helpers');
const { requireHealthDataStorage } = require('../middleware/healthData');

const router = express.Router();

router.post('/grant', requireAuth, requireRole('subscriber'), asyncRoute(ctrl.grantConsent));
router.post('/:practitionerMatchId/revoke', requireAuth, requireRole('subscriber'), asyncRoute(ctrl.revokeConsent));

// Called by a practitioner's own client -- authenticated as a
// practitioner, but the actual data release is gated by the per-match
// consent token re-verified server-side inside the controller, not by
// this role check alone.
// No health data is released to practitioners through the platform. A
// subscriber who wants a practitioner to see their results prints or saves
// their own Health Report and shares it directly. Refused with 410 unless
// storage is explicitly enabled (see middleware/healthData.js).
router.get('/:practitionerMatchId/data', requireAuth, requireRole('practitioner'), requireHealthDataStorage, asyncRoute(ctrl.getDataForPractitioner));

module.exports = router;
