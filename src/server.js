// src/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth.routes');
const subscriberRoutes = require('./routes/subscriber.routes');
const consentRoutes = require('./routes/consent.routes');
const marketplaceRoutes = require('./routes/marketplace.routes');
const bookingRoutes = require('./routes/booking.routes');
const caseRegistryRoutes = require('./routes/caseRegistry.routes');
const adminRoutes = require('./routes/admin.routes');
const practitionerRoutes = require('./routes/practitioner.routes');
const { errorHandler } = require('./middleware/errorHandler');

function createApp() {
  const app = express();

  app.use(helmet());
  // ALLOWED_ORIGIN defaults to '*' for local development -- with only
  // bearer-token auth (no cookies) here, that's a workable dev default,
  // not the severe risk wide-open CORS is for cookie-based auth. But it
  // is NOT a safe production default for a health-data API regardless,
  // and defaulting to it silently in production would be an easy
  // misconfiguration to miss. Fail loudly instead: refuse to start in
  // production without ALLOWED_ORIGIN explicitly set, rather than quietly
  // running wide open.
  if (process.env.NODE_ENV === 'production' && !process.env.ALLOWED_ORIGIN) {
    throw new Error(
      'ALLOWED_ORIGIN must be set explicitly when NODE_ENV=production -- refusing to start with CORS wide open (*) against a real deployment.'
    );
  }
  app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
  app.use(express.json());

  // Baseline rate limiting for every /api/* route. Previously only
  // /api/auth/register and /api/auth/signin had any limiter at all --
  // every other endpoint (booking creation, case-registry submission,
  // consent grants, etc.) had no request-volume protection whatsoever.
  // This is deliberately more generous than authLimiter (that one stays
  // in auth.routes.js, unchanged, for brute-force protection
  // specifically) -- this is baseline abuse/DoS protection for
  // everything else, not a replacement for it.
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: 'Too many requests. Please wait a few minutes and try again.' }),
  });
  app.use('/api', apiLimiter);

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.use('/api/auth', authRoutes);
  app.use('/api/subscriber', subscriberRoutes);
  app.use('/api/consent', consentRoutes);
  app.use('/api/marketplace', marketplaceRoutes);
  app.use('/api/bookings', bookingRoutes);
  app.use('/api/case-registry', caseRegistryRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/practitioner', practitionerRoutes);

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);

  return app;
}

if (require.main === module) {
  const app = createApp();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`AIDH backend scaffold listening on :${port}`));
}

module.exports = { createApp };
