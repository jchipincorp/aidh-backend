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
const billingRoutes = require('./routes/billing.routes');
const researchFeedRoutes = require('./routes/researchFeed.routes');
const consultationRoutes = require('./routes/consultations.routes');
const billingCtrl = require('./controllers/billing.controller');
const { asyncRoute } = require('./routes/_helpers');
const db = require('./config/db');
const { jobStatus } = require('./lib/jobHeartbeat');
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
  if (process.env.NODE_ENV === 'production') {
    // Refuse to start on settings that are quietly unsafe in production, rather than run with them.
    if (!process.env.ALLOWED_ORIGIN || process.env.ALLOWED_ORIGIN.trim() === '*') {
      throw new Error('ALLOWED_ORIGIN must be set to the real front-end origin when NODE_ENV=production -- refusing to start with CORS wide open (unset or "*") against a real deployment.');
    }
    if (process.env.TRUST_PROXY === undefined || process.env.TRUST_PROXY === '') {
      throw new Error('TRUST_PROXY must be set explicitly when NODE_ENV=production: the number of proxies in front of this app (usually 1), or "false" if it is exposed directly. Without it, rate limiting sees every visitor as the proxy\'s address.');
    }
    if (process.env.TRUST_PROXY === 'true') {
      throw new Error('TRUST_PROXY=true trusts any X-Forwarded-For header, so a visitor could forge their address and dodge rate limits. Use the number of proxies (e.g. 1) instead.');
    }
  }
  // Behind a load balancer or reverse proxy every request arrives from the proxy's address; trust proxy tells Express how
  // many proxies to believe, so the rate limiter counts real visitors separately. Number = hops; 'false' = none.
  if (process.env.TRUST_PROXY !== undefined && process.env.TRUST_PROXY !== '') {
    const tp = process.env.TRUST_PROXY;
    app.set('trust proxy', tp === 'false' ? false : /^\d+$/.test(tp) ? Number(tp) : tp);
  }
  const allowedOrigins = (process.env.ALLOWED_ORIGIN || '*')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('CORS origin not allowed'));
    }
  }));

  // Stripe webhook: MUST be registered before app.use(express.json())
  // below, and with express.raw() instead of json() for this one route.
  // stripe.webhooks.constructEvent (called inside handleWebhook) verifies
  // the signature against the exact raw bytes Stripe sent -- a JSON
  // parser would consume the request stream and hand back a re-parsed
  // object, and by the time a route registered after express.json() saw
  // it, the original bytes needed for signature verification would
  // already be gone. This is the single most common way to accidentally
  // break Stripe webhook signature verification, so it gets its own
  // explicit route here rather than living inside billing.routes.js
  // (which is mounted after express.json(), for its other routes that
  // do need normal JSON parsing).
  app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), asyncRoute(billingCtrl.handleWebhook));

  // A resized headshot is ~100 KB as base64, over the default body limit; raised for that one route only.
  app.use('/api/consultations/photo', express.json({ limit: '300kb' }));
  app.use(express.json());

  // Liveness: the process is up and can answer. Deliberately dumb (never touches the database), so a database outage
  // does not make the platform kill and restart healthy app servers.
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  // Readiness: can THIS instance serve real traffic right now? Tests the database, and returns 503 while the process is
  // shutting down so a load balancer stops sending it requests. Also reports the money-critical consultation job as
  // 'never-run' | 'ok' | 'stale' | 'failing': a monitor should alert on 'stale' or 'failing'.
  // Both are registered BEFORE the rate limiter, so frequent uptime checks can never be throttled into a false outage.
  app.get('/api/ready', async (req, res) => {
    if (app.locals.shuttingDown) return res.status(503).json({ ok: false, reason: 'shutting-down' });
    let timer;
    try {
      await Promise.race([db.query('SELECT 1'), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('database timeout')), 2000); })]);
    } catch (e) { return res.status(503).json({ ok: false, db: false }); } finally { clearTimeout(timer); }
    let jobs = 'unknown';
    try { jobs = await jobStatus(); } catch (e) { /* migration 015 not applied yet */ }
    return res.json({ ok: true, db: true, jobs });
  });

  // Baseline rate limiting for every /api/* route. Previously only
  // /api/auth/register and /api/auth/signin had any limiter at all --
  // every other endpoint (booking creation, case-registry submission,
  // consent grants, etc.) had no request-volume protection whatsoever.
  // This is deliberately more generous than authLimiter (that one stays
  // in auth.routes.js, unchanged, for brute-force protection
  // specifically) -- this is baseline abuse/DoS protection for
  // everything else, not a replacement for it.
  //
  // /api/billing/webhook is intentionally NOT covered by this (it's
  // registered above, before this middleware even runs) -- rate-limiting
  // Stripe's own webhook delivery isn't the goal here, and could cause
  // this app to silently drop legitimate billing events during a burst.
  // Its security boundary is the signature check inside handleWebhook,
  // not request volume.
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: 'Too many requests. Please wait a few minutes and try again.' }),
  });
  app.use('/api', apiLimiter);

  app.use('/api/auth', authRoutes);
  app.use('/api/subscriber', subscriberRoutes);
  app.use('/api/consent', consentRoutes);
  app.use('/api/marketplace', marketplaceRoutes);
  app.use('/api/bookings', bookingRoutes);
  app.use('/api/case-registry', caseRegistryRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/practitioner', practitionerRoutes);
  app.use('/api/billing', billingRoutes);
  app.use('/api/consultations', consultationRoutes);
  // Public read, no auth -- the page itself (aidh_research_feed.html) is
  // public, not Premium-gated; see researchFeed.controller.js's own header.
  app.use('/api/research-feed', researchFeedRoutes.publicRouter);
  // Admin-only create/update/delete, same requireAuth+requireRole('admin')
  // pattern as every other /api/admin/* route in this file.
  app.use('/api/admin/research-feed', researchFeedRoutes.adminRouter);

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);

  return app;
}

if (require.main === module) {
  const app = createApp();
  const port = process.env.PORT || 3000;
  const server = app.listen(port, () => console.log(`AIDH backend listening on :${port}`));
  // Optional in-process scheduler for consultation holds and releases. Prefer a real scheduler
  // running scripts/run-consultation-jobs.js; this exists so a small deployment works without one.
  let jobTimer = null;
  if (process.env.CONSULTATION_JOBS_INTERVAL_MS) {
    const { runConsultationJobs } = require('./lib/consultationJobs');
    jobTimer = setInterval(() => runConsultationJobs().catch((e) => console.error('consultation jobs failed', e.message)), parseInt(process.env.CONSULTATION_JOBS_INTERVAL_MS, 10));
  }
  // Graceful shutdown (a deploy, a restart, a scale-down): stop taking new requests, let the ones in flight finish,
  // close the database pool, then exit. /api/ready answers 503 from the first moment so the load balancer drains us.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true; app.locals.shuttingDown = true;
    console.log(`${signal} received: no new requests; finishing the ones in flight`);
    if (jobTimer) clearInterval(jobTimer);
    const force = setTimeout(() => { console.error('Shutdown took longer than 15 seconds: forcing exit'); process.exit(1); }, 15000);
    force.unref();
    server.close(async () => { try { await db.end(); } catch (e) { /* already closed */ } process.exit(0); });
    if (server.closeIdleConnections) server.closeIdleConnections();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { createApp };
