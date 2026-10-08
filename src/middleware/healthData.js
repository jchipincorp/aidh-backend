// src/middleware/healthData.js
//
// Health inputs (the five pillar slider values) and the scores computed
// from them stay on the subscriber's own device. The server does not store
// them and does not release them to anyone, including practitioners.
//
// This is enforced HERE, on the server, not only by the shipped frontend
// choosing not to send them: a stale page, a modified client, or a future
// code change that starts calling these endpoints again gets a 410 and
// nothing is written. Authentication still runs first (a missing or invalid
// token is a 401, not a 410), so this never reveals anything to an
// unauthenticated caller.
//
// To deliberately turn storage back on (for example an explicit, opt-in
// Premium sync built later), set AIDH_STORE_HEALTH_DATA=true. It is read on
// every request, so tests can flip it, and it defaults to OFF.

function healthDataStorageEnabled() {
  return process.env.AIDH_STORE_HEALTH_DATA === 'true';
}

function requireHealthDataStorage(req, res, next) {
  if (healthDataStorageEnabled()) return next();
  return res.status(410).json({
    error: 'This platform does not store health inputs or scores. They stay on your device.',
    code: 'HEALTH_DATA_NOT_STORED',
  });
}

module.exports = { requireHealthDataStorage, healthDataStorageEnabled };
