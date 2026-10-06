// src/routes/caseRegistry.routes.js
const express = require('express');
const ctrl = require('../controllers/caseRegistry.controller');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncRoute } = require('./_helpers');

const router = express.Router();

router.post('/', requireAuth, requireRole('practitioner'), asyncRoute(ctrl.submitCaseEntry));

// Public read -- matches aidh_case_directory.html's "open to everyone" browsing.
router.get('/', asyncRoute(ctrl.listPublishedCases));

module.exports = router;
