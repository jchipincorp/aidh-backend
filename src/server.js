// src/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const authRoutes = require('./routes/auth.routes');
const subscriberRoutes = require('./routes/subscriber.routes');
const consentRoutes = require('./routes/consent.routes');
const marketplaceRoutes = require('./routes/marketplace.routes');
const bookingRoutes = require('./routes/booking.routes');
const caseRegistryRoutes = require('./routes/caseRegistry.routes');
const adminRoutes = require('./routes/admin.routes');
const { errorHandler } = require('./middleware/errorHandler');

function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
  app.use(express.json());

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.use('/api/auth', authRoutes);
  app.use('/api/subscriber', subscriberRoutes);
  app.use('/api/consent', consentRoutes);
  app.use('/api/marketplace', marketplaceRoutes);
  app.use('/api/bookings', bookingRoutes);
  app.use('/api/case-registry', caseRegistryRoutes);
  app.use('/api/admin', adminRoutes);

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
