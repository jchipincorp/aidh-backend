// tests/fakeStripeClient.js
//
// A configurable fake standing in for src/lib/stripeClient.js's real
// Stripe SDK instance, injected via the exact same require.cache
// override pattern already used for src/config/db.js throughout this
// suite. Chosen over HTTP-level mocking (nock) after nock's low-level
// socket interception (@mswjs/interceptors under the hood) was found to
// hang indefinitely in this sandbox -- traced and confirmed the
// controller code itself is correct and completes normally either way
// (proven by letting an unmocked real Stripe call run through and fail
// cleanly against this sandbox's own network egress block, rather than
// hanging); the hang was specifically nock's interception layer
// conflicting with this environment's own network proxy, not a bug in
// this codebase. This fake only replaces the HTTP-calling resources
// (customers, setupIntents, paymentMethods, subscriptions) -- webhooks
// (signature creation/verification) comes from the REAL Stripe package
// instead, since that's pure local HMAC computation with no network
// call at all, so there's no reason to fake it and every reason not to:
// the webhook signature tests in billing.test.js are proving the real
// verification algorithm actually works, not a stand-in for it.
const RealStripe = require('stripe');
const realWebhooksOnly = RealStripe('sk_test_unused_key_webhooks_are_local_only');

/** calls: records every method invocation as {resource, method, args}
 * so a test can assert exactly what was sent to Stripe, not just what
 * came back. responses: a map like { 'customers.create': fn(args) =>
 * result } -- a function so a test can return different fixtures based
 * on the actual arguments, or throw to simulate a Stripe-side error. */
function buildFakeStripeClient(responses = {}) {
  const calls = [];

  function makeResource(resourceName, methodNames) {
    const resource = {};
    methodNames.forEach((methodName) => {
      resource[methodName] = async (...args) => {
        calls.push({ resource: resourceName, method: methodName, args });
        const key = `${resourceName}.${methodName}`;
        const handler = responses[key];
        if (!handler) {
          throw new Error(`fakeStripeClient: no response configured for ${key} -- the code under test called a Stripe method this test didn't expect. Args: ${JSON.stringify(args)}`);
        }
        return handler(...args);
      };
    });
    return resource;
  }

  return {
    customers: makeResource('customers', ['create', 'update', 'retrieve']),
    setupIntents: makeResource('setupIntents', ['create']),
    paymentMethods: makeResource('paymentMethods', ['attach']),
    subscriptions: makeResource('subscriptions', ['create', 'cancel']),
    // Consultations (Stripe Checkout + Connect + transfers). Same rule as above: only the
    // HTTP-calling resources are faked.
    checkout: { sessions: makeResource('checkout.sessions', ['create', 'expire', 'retrieve']) },
    accounts: makeResource('accounts', ['create', 'retrieve', 'list']),
    balance: makeResource('balance', ['retrieve']),
    accountLinks: makeResource('accountLinks', ['create']),
    paymentIntents: makeResource('paymentIntents', ['retrieve']),
    refunds: makeResource('refunds', ['create', 'list']),
    transfers: makeResource('transfers', ['create', 'retrieve']),
    webhooks: realWebhooksOnly.webhooks,
    _calls: calls,
  };
}

module.exports = { buildFakeStripeClient, realStripeWebhooks: realWebhooksOnly.webhooks };
