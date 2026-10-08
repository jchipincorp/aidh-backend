// src/routes/subscriber.routes.js
const express = require('express');
const ctrl = require('../controllers/subscriber.controller');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncRoute } = require('./_helpers');
const { requireHealthDataStorage } = require('../middleware/healthData');

const router = express.Router();
router.use(requireAuth, requireRole('subscriber'));

// Health inputs/scores/lab values are not stored server-side (see
// middleware/healthData.js). Refused with 410 unless explicitly enabled.
router.post('/sliders', requireHealthDataStorage, asyncRoute(ctrl.recordSliders));
router.get('/sliders/latest', requireHealthDataStorage, asyncRoute(ctrl.getLatestSnapshot));
router.post('/lab-results', requireHealthDataStorage, asyncRoute(ctrl.recordLabResult));
router.delete('/me', asyncRoute(ctrl.deleteMyAccount));

module.exports = router;
