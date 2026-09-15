// src/routes/auth.routes.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const ctrl = require('../controllers/auth.controller');
const { asyncRoute } = require('./_helpers');

const router = express.Router();

// Addresses "add rate limiting / lockout on repeated failed sign-in
// attempts" from AIDH_Pre_Production_Requirements.docx.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

router.post('/register', authLimiter, asyncRoute(ctrl.register));
router.post('/signin', authLimiter, asyncRoute(ctrl.signin));
router.post('/verify', asyncRoute(ctrl.verifyEmail));

module.exports = router;
