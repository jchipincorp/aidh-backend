// src/routes/practitioner.routes.js
const express = require('express');
const ctrl = require('../controllers/practitioner.controller');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncRoute } = require('./_helpers');

const router = express.Router();
router.use(requireAuth, requireRole('practitioner'));

router.get('/profile', asyncRoute(ctrl.getProfile));
router.patch('/profile', asyncRoute(ctrl.updateProfile));

module.exports = router;
