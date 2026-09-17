// src/routes/marketplace.routes.js
const express = require('express');
const ctrl = require('../controllers/marketplace.controller');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncRoute } = require('./_helpers');

const router = express.Router();

// Public and unauthenticated, matching the frontend's "free to browse,
// no sign-up required" marketplace positioning.
router.get('/disciplines', asyncRoute(ctrl.listDisciplines));

router.post('/matches', requireAuth, requireRole('subscriber'), asyncRoute(ctrl.createMatch));

module.exports = router;
