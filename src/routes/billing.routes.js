// src/routes/billing.routes.js
const express = require('express');
const ctrl = require('../controllers/billing.controller');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncRoute } = require('./_helpers');

const router = express.Router();

// The webhook route is deliberately NOT defined here -- it's mounted
// directly in server.js, BEFORE the app-level express.json() call. See
// that file's comment for why: express.json() runs for every request
// that reaches it regardless of which router eventually handles it, so
// mounting the raw-body webhook route on a sub-router registered AFTER
// express.json() would receive an already-parsed, already-consumed
// body -- Stripe's signature check needs the exact original bytes, not
// a JSON.parse/stringify round-trip of them, and by then the raw
// stream can't be re-read anyway.

router.use(requireAuth, requireRole('subscriber'));
router.post('/setup-intent', asyncRoute(ctrl.createSetupIntent));
router.post('/subscribe', asyncRoute(ctrl.subscribe));
router.post('/cancel', asyncRoute(ctrl.cancelSubscription));
router.get('/status', asyncRoute(ctrl.getStatus));

module.exports = router;
