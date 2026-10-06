// src/routes/_helpers.js
/** Wraps an async controller so a rejected promise reaches Express's
 * error handler instead of crashing the process unhandled. */
function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { asyncRoute };
