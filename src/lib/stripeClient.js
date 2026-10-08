// src/lib/stripeClient.js
//
// Thin wrapper around the real Stripe Node SDK, configured from
// STRIPE_SECRET_KEY. Kept as its own module (rather than requiring
// 'stripe' directly in the controller) for the same reason
// src/config/db.js is its own module: it gives tests a single,
// consistent point to intercept -- here via `nock` mocking the actual
// HTTP calls the real SDK makes to api.stripe.com, exactly the same
// "swap what's under the real code" pattern already used throughout
// this test suite, never a hand-rolled fake client with its own,
// possibly-wrong idea of what Stripe's API looks like.
const Stripe = require('stripe');

// Real Stripe SDK, configured from STRIPE_SECRET_KEY. Falls back to an
// obviously-fake placeholder key if unset, rather than throwing at
// import time -- that would crash the whole app on startup, including
// paths that never touch billing at all (tests, other routes). Every
// function in billing.controller.js that actually calls Stripe checks
// for a real key first and returns a clear 500 instead of a confusing
// Stripe-side auth error if it's missing -- see subscribe()'s
// STRIPE_PRICE_ID check for the same pattern applied to price ids.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder_key_not_configured', {
  apiVersion: '2024-06-20',
});

module.exports = stripe;
