// tests/production_config.test.js -- the server refuses to start on settings that are quietly unsafe in production.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { buildTestDb } = require('./setup');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.FIELD_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.STRIPE_SECRET_KEY = 'sk_test_fixture_key';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fixture';
const dbConfigPath = path.join(__dirname, '..', 'src', 'config', 'db.js');

// Build the app under a given environment, then put the environment back exactly as it was.
function build(env) {
  const keys = ['NODE_ENV', 'ALLOWED_ORIGIN', 'TRUST_PROXY'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  keys.forEach((k) => delete process.env[k]);
  // NB: assigning undefined to process.env stores the TEXT "undefined", so an unset value must be deleted instead.
  Object.entries(env).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  try {
    Object.keys(require.cache).forEach((key) => { if (key.includes('/src/')) delete require.cache[key]; });
    require.cache[require.resolve(dbConfigPath)] = { id: dbConfigPath, filename: dbConfigPath, loaded: true, exports: buildTestDb() };
    return require('../src/server').createApp();
  } finally { keys.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); }
}
const PROD = { NODE_ENV: 'production', ALLOWED_ORIGIN: 'https://www.example.com', TRUST_PROXY: '1' };

test('PRODUCTION: a correct configuration starts, and trust proxy is the number of hops given', () => {
  assert.equal(build(PROD).get('trust proxy'), 1);
  assert.equal(build({ ...PROD, TRUST_PROXY: '2' }).get('trust proxy'), 2);
  assert.equal(build({ ...PROD, TRUST_PROXY: 'false' }).get('trust proxy'), false, '"false" means exposed directly, no proxy trusted');
});

test('PRODUCTION: CORS wide open is refused, whether unset or "*" (the old example file shipped "*")', () => {
  assert.throws(() => build({ ...PROD, ALLOWED_ORIGIN: undefined }), /ALLOWED_ORIGIN/);
  assert.throws(() => build({ NODE_ENV: 'production', TRUST_PROXY: '1' }), /ALLOWED_ORIGIN/);
  assert.throws(() => build({ ...PROD, ALLOWED_ORIGIN: '*' }), /ALLOWED_ORIGIN/);
  assert.throws(() => build({ ...PROD, ALLOWED_ORIGIN: ' * ' }), /ALLOWED_ORIGIN/);
});

test('PRODUCTION: TRUST_PROXY must be set, and "true" (trust any forwarded address) is refused', () => {
  assert.throws(() => build({ NODE_ENV: 'production', ALLOWED_ORIGIN: 'https://www.example.com' }), /TRUST_PROXY must be set/);
  assert.throws(() => build({ ...PROD, TRUST_PROXY: '' }), /TRUST_PROXY must be set/);
  assert.throws(() => build({ ...PROD, TRUST_PROXY: 'true' }), /forged|trusts any/i);
});

test('DEVELOPMENT: none of these checks get in the way of local work', () => {
  const app = build({});
  assert.equal(app.get('trust proxy'), false, 'default Express setting when nothing is configured');
  assert.equal(build({ TRUST_PROXY: '1' }).get('trust proxy'), 1);
});
