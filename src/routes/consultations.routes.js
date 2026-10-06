// src/routes/consultations.routes.js
const express = require('express');
const ctrl = require('../controllers/consultations.controller');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncRoute } = require('./_helpers');

const router = express.Router();

// Public: browsing bookable practitioners and their open times.
router.get('/practitioners', asyncRoute(ctrl.listPractitioners));
router.get('/practitioners/:id/slots', asyncRoute(ctrl.getSlots));
router.get('/practitioners/:id/photo', asyncRoute(ctrl.getPublicPhoto));
router.get('/terms', asyncRoute(ctrl.getTerms));
router.get('/agreement', asyncRoute(ctrl.getAgreement));

// Practitioner: their own booking settings, weekly availability, Stripe payouts, and bookings.
router.get('/settings', requireAuth, requireRole('practitioner'), asyncRoute(ctrl.getSettings));
router.put('/settings', requireAuth, requireRole('practitioner'), asyncRoute(ctrl.putSettings));
router.post('/agreement/accept', requireAuth, requireRole('practitioner'), asyncRoute(ctrl.acceptAgreement));
router.put('/availability', requireAuth, requireRole('practitioner'), asyncRoute(ctrl.putAvailability));
router.put('/photo', requireAuth, requireRole('practitioner'), asyncRoute(ctrl.putPhoto));
router.delete('/photo', requireAuth, requireRole('practitioner'), asyncRoute(ctrl.deletePhoto));
router.get('/photo/mine', requireAuth, requireRole('practitioner'), asyncRoute(ctrl.getMyPhoto));
router.post('/connect/onboard', requireAuth, requireRole('practitioner'), asyncRoute(ctrl.connectOnboard));
router.get('/connect/status', requireAuth, requireRole('practitioner'), asyncRoute(ctrl.connectStatus));
router.get('/practitioner/bookings', requireAuth, requireRole('practitioner'), asyncRoute(ctrl.practitionerBookings));

// Subscriber: book, list their own.
router.post('/book', requireAuth, requireRole('subscriber'), asyncRoute(ctrl.book));
router.get('/mine', requireAuth, requireRole('subscriber'), asyncRoute(ctrl.myBookings));
router.get('/quote/:practitionerId', requireAuth, requireRole('subscriber'), asyncRoute(ctrl.getQuote));

// Admin: resolve a reported problem.
router.post('/admin/:id/resolve', requireAuth, requireRole('admin'), asyncRoute(ctrl.adminResolve));

// A single booking: only its own subscriber or its own practitioner (checked in the controller).
router.get('/:id', requireAuth, asyncRoute(ctrl.getBooking));
router.post('/:id/cancel', requireAuth, requireRole('subscriber', 'practitioner'), asyncRoute(ctrl.cancelBooking));
router.post('/:id/report-issue', requireAuth, requireRole('subscriber'), asyncRoute(ctrl.reportIssue));
router.post('/:id/complete', requireAuth, requireRole('practitioner'), asyncRoute(ctrl.markComplete));

module.exports = router;
