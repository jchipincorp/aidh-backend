// src/routes/researchFeed.routes.js
const express = require('express');
const ctrl = require('../controllers/researchFeed.controller');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncRoute } = require('./_helpers');

// Public router: mounted at /api/research-feed in server.js, no auth.
const publicRouter = express.Router();
publicRouter.get('/', asyncRoute(ctrl.list));

// Admin router: mounted at /api/admin/research-feed in server.js,
// alongside the existing admin.routes.js pattern (requireAuth +
// requireRole('admin') on the whole router, not per-route).
const adminRouter = express.Router();
adminRouter.use(requireAuth, requireRole('admin'));
adminRouter.get('/', asyncRoute(ctrl.listAll));
adminRouter.post('/', asyncRoute(ctrl.create));
adminRouter.patch('/:id', asyncRoute(ctrl.update));
adminRouter.delete('/:id', asyncRoute(ctrl.remove));

module.exports = { publicRouter, adminRouter };
