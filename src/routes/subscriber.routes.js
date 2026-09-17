// src/routes/subscriber.routes.js
const express = require('express');
const ctrl = require('../controllers/subscriber.controller');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncRoute } = require('./_helpers');

const router = express.Router();
router.use(requireAuth, requireRole('subscriber'));

router.post('/sliders', asyncRoute(ctrl.recordSliders));
router.get('/sliders/latest', asyncRoute(ctrl.getLatestSnapshot));
router.post('/lab-results', asyncRoute(ctrl.recordLabResult));
router.delete('/me', asyncRoute(ctrl.deleteMyAccount));

module.exports = router;
