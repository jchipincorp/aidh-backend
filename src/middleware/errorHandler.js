// src/middleware/errorHandler.js
function errorHandler(err, req, res, next) {
  console.error(err); // TODO production: send to real error tracking (Sentry or equivalent)

  // Never leak raw database errors or stack traces to the client --
  // a Postgres constraint violation message can reveal schema details.
  const status = err.status || 500;
  const message = status === 500 ? 'Internal server error' : err.message;
  res.status(status).json({ error: message });
}

module.exports = { errorHandler };
