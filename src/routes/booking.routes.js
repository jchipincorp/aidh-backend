// src/routes/booking.routes.js
const express = require('express');
const ctrl = require('../controllers/booking.controller');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncRoute } = require('./_helpers');

const router = express.Router();
router.post('/', requireAuth, requireRole('subscriber'), asyncRoute(ctrl.createBookingRequest));

module.exports = router;
