// src/routes/auth.routes.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const ctrl = require('../controllers/auth.controller');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('./_helpers');

const router = express.Router();

// Addresses "add rate limiting / lockout on repeated failed sign-in
// attempts" from AIDH_Pre_Production_Requirements.docx.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  // Default express-rate-limit response is plain text/html, breaking the
  // JSON-error contract every other /api/* endpoint follows (see
  // errorHandler.js) -- a client that does JSON.parse() on every error
  // body, as aidh-api-client.js does, gets a swallowed parse failure and
  // an undefined error message right when the user most needs a clear
  // one. Found via an actual 25-request rate-limit test, not just a read
  // of the config.
  handler: (req, res) => res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' }),
});

router.post('/register', authLimiter, asyncRoute(ctrl.register));
router.post('/signin', authLimiter, asyncRoute(ctrl.signin));
router.post('/verify', requireAuth, asyncRoute(ctrl.verifyEmail));
router.post('/logout', requireAuth, asyncRoute(ctrl.logout));
router.post('/logout-all', requireAuth, asyncRoute(ctrl.logoutAll));

module.exports = router;
