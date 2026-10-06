// src/lib/fieldEncryption.js
//
// Application-layer AES-256-GCM encryption for the handful of columns
// most likely to carry identifiable health narrative or lab values --
// case_entries.change_summary and lab_results.value (see migration 006).
//
// This is defense-in-depth, not the primary encryption-at-rest control.
// The primary control is still provider-level storage encryption (e.g.
// an encrypted RDS/Cloud SQL volume) -- a deployment setting, not
// something any application code can enforce. What this module adds is
// a second layer: even a raw disk snapshot, a misconfigured backup
// bucket, or a leaked DB dump doesn't expose these fields in plaintext
// without FIELD_ENCRYPTION_KEY, which lives only in the app's
// environment, never in the database itself.
//
// Ciphertext format: base64(iv [12 bytes] || authTag [16 bytes] || ciphertext)
// stored as a single opaque string, so encrypted columns stay plain TEXT.

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;   // GCM-recommended IV length
const TAG_LENGTH = 16;

function getKey(keyOverride) {
  const hex = keyOverride || process.env.FIELD_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      'FIELD_ENCRYPTION_KEY is not set. Generate one with: ' +
      `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error('FIELD_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).');
  }
  return key;
}

/** Encrypts a plaintext string for storage. Returns null for null/undefined
 * input so optional fields don't need special-casing at call sites.
 * keyHex is optional -- every normal call site omits it and uses
 * FIELD_ENCRYPTION_KEY from the environment, as before. It exists only
 * for scripts/rotate-encryption-key.js, which needs to encrypt under an
 * explicit NEW key while decryptField below reads the OLD key from a
 * separate variable in the same process -- juggling process.env for that
 * would be far more error-prone than an explicit parameter. */
function encryptField(plaintext, keyHex) {
  if (plaintext === null || plaintext === undefined) return null;
  const key = getKey(keyHex);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/** Decrypts a value produced by encryptField. Returns null for null/undefined
 * input, matching encryptField's symmetry. Throws if the ciphertext has been
 * tampered with or the key is wrong -- GCM's auth tag makes that detectable
 * rather than silently returning garbage. keyHex is optional, same reason
 * as encryptField above. */
function decryptField(stored, keyHex) {
  if (stored === null || stored === undefined) return null;
  const key = getKey(keyHex);
  const raw = Buffer.from(stored, 'base64');
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = { encryptField, decryptField };
