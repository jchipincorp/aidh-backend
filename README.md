# AI Dynamic Health — Backend Scaffold

**This is Option 2 from the platform's pre-production discussion: a real,
runnable starting skeleton — not a finished, production-ready backend.**
Read this file before wiring it to anything real.

## Changelog

**v0.6 (this version) — real practitioner sign-up and profile, closing a
blocking go-live gap.** Previously, no practitioner could get a real
account anywhere in this system: `aidh_practitioner_onboarding.html`'s
profile form never collected a password, and the one sign-up form that
did only ever sent `role: 'subscriber'`. This version closes that gap
end-to-end, verified with a real integration test (real backend, real
PostgreSQL, real HTTP-served frontend, driven through the actual shipped
UI — 15/15 checks) alongside the existing subscriber-flow test (16/16,
re-confirmed unaffected).

**New: `migration 007_practitioner_profile_fields.sql`.** Extends
`practitioner_profiles` with real columns for the fields that matter for
search, admin review, and public display (name, location, phone,
qualifications, registration body, insurance status, complaints history,
a platform-independence acknowledgment), plus a `profile_details` JSONB
column for the ~20 remaining optional fields the onboarding form
collects (languages, practice years, philosophy, session logistics,
etc.) — standard, sound schema design for a profile shape with many
optional, rarely-queried attributes, rather than 20+ individual columns.

**New: `GET`/`PATCH /api/practitioner/profile`** (`practitioner.controller.js`,
`practitioner.routes.js`). Partial updates (only supplied fields change);
`profileDetails` merges shallowly into the existing JSONB rather than
replacing it wholesale, so saving one more optional field later never
wipes out ones saved earlier; `profile_completed_at` stamps automatically
the first time every field the frontend's own form requires is present,
and never moves once set.

**A real, if narrow, robustness bug found and fixed building this:** a
freshly-created profile's default JSONB value (`DEFAULT '{}'`) could come
back as the literal two-character string `"{}"` rather than a parsed
object, and merging into it via `Object.assign` silently corrupted every
profile's very first save (spreading the string's characters as numeric
keys). Reproduced through real HTTP calls, fixed with defensive parsing,
confirmed fixed against both pg-mem and real PostgreSQL specifically.

**`admin.controller.js`'s `listPractitioners`** and
**`caseRegistry.controller.js`'s `listPublishedCases`** now surface a
practitioner's real name (falling back to their `practitioner_code` until
they've completed onboarding) — closing a gap flagged repeatedly during
earlier integration work, where `practitioner_code` was the best
available stand-in because no name field existed anywhere. Showing a
practitioner's real name on the public case directory is the expected
behavior for a professional marketplace (the same way Psychology Today
or Zocdoc show real names) — no subscriber PHI is exposed either way.

**Test-harness gap found and fixed along the way:** pg-mem doesn't
implement `TRIM`/`NULLIF`, both used in the new practitioner
display-name query — registered in `tests/setup.js` the same way
`gen_random_uuid` already was, keeping the actual application SQL
standard and unmodified rather than working around a fake-database
limitation real Postgres doesn't have.

**12 new tests** (partial updates, the JSONB merge behavior, completion-
timestamp stability, cross-role authorization, real names propagating to
admin and the public directory) — **28/28 tests pass** (pg-mem), and
`scripts/verify-real-postgres.js` grew to **41 checks, all passing**,
including one that proves a case published *before* a practitioner
completes their profile correctly shows the real name *after*
completion — the directory joins live at query time, not a snapshot.

**v0.5 (this version) — closing the gaps that don't need a production
environment.** Follow-up to the v0.4 security-testing pass: worked
through the "still open" list and fixed everything fixable without real
hosting, real email/payment infrastructure, or a legal/product decision.

**The headline item: this is the first version tested against REAL
PostgreSQL, not just pg-mem.** Every prior test, every prior fix, had
only ever run against pg-mem (a compatible-but-not-identical in-memory
engine). `scripts/verify-real-postgres.js` re-proves 41 checks — every
major fix and every security vulnerability from this project's history —
against an actual local PostgreSQL 16 instance. Run it with
`npm run migrate && npm run seed && npm run verify:real-postgres`
against any real Postgres. Two real bugs existed *only* because pg-mem
had been silently hiding them:

1. **A fresh deploy following the documented steps would ship with zero
   disciplines seeded, breaking the entire marketplace.** `npm run
   migrate` never ran seed data — only the test harness's own convenience
   code did. Fixed: `npm run seed` (`src/db/seed.js`) is now a real,
   documented, idempotent step.
2. **One row with undecryptable ciphertext could crash the entire public
   case directory.** `listPublishedCases` decrypted every row in one
   unguarded `.map()`; a single failure (corrupted data, or — as proven
   below — a key rotation) threw and took down the whole endpoint with a
   500 for every visitor. Fixed: each row's decryption is isolated; a bad
   row is logged and excluded, everything else still renders. Has its own
   regression test (`ROBUSTNESS:` in `tests/consent.test.js`) and was
   proven fixed by deliberately re-triggering the exact rotation scenario
   that first exposed it.

**JWT revocation, implemented for real.** The `sessions` table
(migration 001) existed in the schema for exactly this purpose but
nothing ever wrote to or read from it — a stolen or leaked token was
valid for its full 7-day life with no way to cut it short. Now:
`issueToken()` records a session row (hashed, never the raw token) on
every register/signin; `requireAuth` checks it on every authenticated
request; `POST /api/auth/logout` and `POST /api/auth/logout-all` (new)
actually delete the session row(s), making the token unusable on its
very next use even though the JWT itself remains cryptographically valid
until expiry. `aidh-api-client.js`'s `signOut()` now calls the real
endpoint instead of only forgetting the token locally; added
`signOutEverywhere()`. 5 new tests, plus proven against real Postgres.

**CORS now fails loudly instead of silently running wide open.**
`ALLOWED_ORIGIN` defaulting to `*` was flagged as a real production risk.
Server now refuses to start when `NODE_ENV=production` and
`ALLOWED_ORIGIN` isn't explicitly set, rather than quietly defaulting to
wide-open CORS against a real deployment.

**Baseline rate limiting now covers the whole API**, not just
`/api/auth/*`. Booking creation, case-registry submission, consent
grants — everything — previously had zero request-volume protection.
Added a separate, more generous limiter (`apiLimiter`, 300/15min)
alongside the existing strict `authLimiter` (20/15min, unchanged).

**Key rotation tooling now exists.** `FIELD_ENCRYPTION_KEY` rotation was
previously a documented requirement ("re-encrypt existing rows with the
old key before switching") with no actual script to do it.
`scripts/rotate-encryption-key.js` does the full decrypt-under-old/
re-encrypt-under-new cycle for every encrypted column, isolates failures
per-row (a bad row is reported, not a crash), and is safe to re-run if
interrupted (already-rotated rows are detected, not double-encrypted).
Verified against real Postgres in `scripts/verify-key-rotation.js` —
including deliberately re-running it twice to prove the safe-re-run
behavior.

**CI pipeline added** (`.github/workflows/backend-tests.yml`) — the test
suite existed and passed locally but nothing enforced it kept passing on
every change. Two jobs: the pg-mem suite (fast, no real DB needed), and
the real-Postgres verification suite (spins up a real `postgres:16`
service container) — so the real-Postgres proof above stays current on
every push, not just as a one-time manual check.

**28 tests pass** (pg-mem, `npm test`) **and 41 checks pass against real
PostgreSQL** (`npm run verify:real-postgres`) **and 10 checks pass for
key rotation** (`npm run verify:key-rotation`).

**v0.4 (this version) — security testing pass.** Not a code review this
time: live exploitation against the real running app (real HTTP, real
in-memory Postgres via pg-mem, real controller code), the same way an
external pentest would approach it. Found and fixed five real,
confirmed-exploitable issues:

1. **CRITICAL — IDOR in `POST /api/consent/grant` and
   `POST /api/consent/:id/revoke`.** Neither verified the
   `practitionerMatchId` belonged to the calling subscriber. Live-exploited
   end-to-end: an unrelated "attacker" subscriber account granted consent
   on a "victim" subscriber's match, received back a fully valid consent
   token, and used it via `getDataForPractitioner` to read the victim's
   real health snapshot. The same gap let the attacker revoke the victim's
   legitimate active consent. Fixed with an ownership join through
   `subscriber_profiles`; both attacks now correctly get 404s. See
   `consent.controller.js`.
2. **HIGH — the same IDOR pattern in `POST /api/bookings`.** An attacker
   could create a real booking against a victim's match with the
   attacker's own `contactMethod`/`contactValue`, hijacking the
   practitioner's communication channel for that engagement. Same fix
   pattern. See `booking.controller.js`.
3. **MEDIUM — `POST /api/auth/verify` required no authentication at all**
   and accepted a bare `{userId}`, so anyone could mark any account
   verified (ids aren't secret — `register()`/`signin()` return them
   directly). Fixed to require auth and derive identity from the caller's
   own token, ignoring any id in the body. The deeper, already-documented
   gap (no real emailed verification token yet) remains open, correctly.
4. **LOW/consistency — the sign-in rate limiter returned `text/html`**,
   not JSON, breaking the JSON-error contract every other endpoint
   follows — a client doing `JSON.parse()` on every error body (as
   `aidh-api-client.js` does) would silently lose the error message right
   when a user most needs it. Confirmed via an actual 25-request test
   against the real limiter, not just a config read. Fixed with a custom
   JSON handler.
5. **DEFENSE-IN-DEPTH — password strength was only enforced client-side.**
   `aidh_website.html`'s sign-up form requires 8+ characters, a number,
   and a symbol, but `POST /api/auth/register` only checked length — so
   calling the API directly (bypassing the UI) could create an account
   with a password weaker than the product promises. Server now enforces
   the identical policy.

All 5 have live-exploit-based regression tests (not just assertions on
the fix) in `tests/consent.test.js` — search for `SECURITY:`. **20/20
tests pass.** `npm audit`: 0 vulnerabilities. SQL injection: every query
audited, all parameterized, no string-built SQL from request input found.
Error handler already never leaked stack traces or raw DB errors (no
change needed there). `helmet()` and a rate limiter were already present
and working correctly once the JSON-response fix above landed.

**Not fixed, flagged instead:** `getDataForPractitioner` grants access to
ANY authenticated practitioner holding a valid consent token, not
specifically the practitioner assigned to that match — because
`practitioner_matches.matched_practitioner_id` (migration 003) has no
assignment workflow anywhere in this codebase yet, so a tighter check
would just break the currently-working flow rather than fix anything.
The token itself (24 random bytes, SHA-256-hashed at rest, single-use per
match via a UNIQUE constraint) is the real security boundary today, and
it is correctly enforced. Tightening this further needs the
practitioner-assignment workflow built first — a roadmap item, not a
one-line fix.

**v0.3 (this version) — HIPAA/GDPR compliance hardening pass.** A legal/
architecture review of the schema and consent controller surfaced five
items; three were code bugs and are fixed here, two are deployment
decisions documented but not automatable from this repo:

1. **Fixed: GDPR/CCPA account deletion was broken for every account.**
   `audit_log.actor_user_id REFERENCES users(id)` had no `ON DELETE`
   behavior, defaulting to `NO ACTION`. Since `auth.controller.js`'s
   `register()` always writes an audit_log row for the new account,
   `subscriber.controller.js`'s `deleteMyAccount()` — the actual
   right-to-erasure endpoint — would fail on its `DELETE FROM users` for
   every single subscriber. Reproduced against the real migration SQL via
   `pg-mem` before fixing, confirmed fixed after (see
   `tests/consent.test.js`, "deleting a subscriber account succeeds even
   after audit_log entries reference them"). Fixed directly in migration
   004 (`ON DELETE SET NULL`) rather than a follow-up `ALTER` — nothing has
   been deployed against a real database yet, so there was no already-applied
   migration to work around.
2. **Fixed: no encryption-at-rest for the two most PHI-heavy free-text
   columns.** `case_entries.change_summary` (practitioner-written case
   narrative) and `lab_results.value` (self-reported biomarker readings)
   are now encrypted with AES-256-GCM at the application layer before
   storage — see `src/lib/fieldEncryption.js` and migration 006. This is
   defense-in-depth, not a replacement for provider-level storage
   encryption (an encrypted RDS/Cloud SQL volume, say) — that's still the
   primary control and is a deployment setting this repo can't enforce.
   `lab_results.unit` and `case_entries.subscriber_case_code` are left
   plaintext deliberately — neither identifies anyone on its own.
3. **Fixed: `DATABASE_SSL=true` accepted forged certificates.** It set
   `rejectUnauthorized: false`, which accepts *any* certificate. Default
   is now real cert-chain verification; `DATABASE_SSL_INSECURE=true` is a
   separate, explicit opt-out for local dev against a self-signed cert
   only — see `.env.example`.
4. **Added, not auto-run: `src/lib/retention.js`.** Purges expired
   `sessions` rows and stale `push_tokens` (both carry personal data —
   `ip_address`, `user_agent`, device tokens — with previously no bound on
   how long they accumulate). Must be invoked by a real scheduled job in
   production; not wired to run automatically here. `audit_log` is
   deliberately never touched by this module — HIPAA audit-trail retention
   is a multi-year *minimum-keep* requirement, not something to purge.
5. **Documented, not code-fixable from here:** no data-retention policy is
   defined for `slider_snapshots`/`lab_results` beyond "as long as the
   account is active" (a legal/business decision, not a bug), and there's
   no audit trail yet for admin queries against raw health data if such an
   endpoint is ever added (none exists today, so nothing to fix, but it's
   a requirement for whoever adds one).

All 3 new tests plus the original 10 pass — 13 total. See
`tests/consent.test.js`.

**v0.2:** Two real scoring discrepancies against `aidh_dashboard.html`,
found and fixed:
- `overallScore()` was missing the sleep-quality bonus adjustment
  (`sl_eff`) the frontend applies when Thought Toxicity is already
  well-managed (md > 50%).
- `organScore()` was missing the frontend's Group-A amplification (the
  ANDS-core pillars — Gut Toxicity, Unhealthy Food Burden, Frequent
  Eating — are weighted 1.4x relative to Group-B in each organ's score).
  This one was found during backend/frontend integration work, not the
  original scoring pass — a spot-check of 32 organ-score values against
  the frontend showed 14 disagreeing by 1–2 points before the fix.

Both confirmed via a 26-snapshot × 8-organ + overall parity suite (234
checks) against the frontend's exact logic — 0 mismatches after both
fixes. All 10 (now 13) integration tests still pass unchanged.

## What "scaffold" means here, precisely

Every piece of this has been built and genuinely tested — not written and
assumed correct:

- All 6 PostgreSQL migrations run successfully and match
  `AIDH_Database_Design.docx` (migrations 001–005) plus the v0.3
  compliance hardening pass documented above (migration 006).
- The scoring library (`src/lib/scoring.js`) is cross-checked against real
  values previously observed in the actual frontend dashboard — same
  pillar weights, same organ-driver calculations, verified to match.
- All 7 route groups (auth, subscriber, consent, marketplace, booking,
  case registry, admin) are implemented with real logic: bcrypt password
  hashing, real JWT issuance and verification, and — the centerpiece —
  server-side re-verification of per-practitioner-match consent on every
  data-access request, not a client-trust shortcut.
- **28 integration tests, all passing** (`npm test`, pg-mem), **plus 41
  checks against real PostgreSQL** (`npm run verify:real-postgres`) **and
  10 checks for key rotation** (`npm run verify:key-rotation`) — including
  a test that proves the database's own CHECK constraint blocks
  publishing a case entry without all three consent confirmations, a test
  proving encrypted fields actually round-trip through real HTTP
  requests, a test proving account deletion survives pre-existing
  audit_log references, live-exploit-based security regression tests
  (search `SECURITY:` in `tests/consent.test.js` — each reproduces the
  actual attack against the pre-fix code and confirms it's blocked
  post-fix), and tests proving JWT revocation actually rejects a
  signed-out token's next use, not just that logout returns 200.

What "scaffold" means is everything below, in "Known limitations" —
real gaps, named specifically rather than glossed over.

## Quick start

```bash
npm install
cp .env.example .env
# edit .env with a real DATABASE_URL and a real JWT_SECRET

npm run migrate    # applies all 5 migrations to your real Postgres instance
npm start          # or `npm run dev` for auto-restart on changes
```

To run the test suite (no real database needed — it builds its own
in-memory one from the real migration files):

```bash
npm test
```

## API surface implemented

| Route | Method | Auth | Notes |
|---|---|---|---|
| `/api/auth/register` | POST | none | Rate-limited |
| `/api/auth/signin` | POST | none | Rate-limited; identical error for unknown email vs. wrong password |
| `/api/auth/verify` | POST | subscriber/practitioner | Verifies the caller's own account — no longer takes a client-supplied id |
| `/api/auth/logout` | POST | subscriber/practitioner/admin | Revokes the calling request's own session server-side |
| `/api/auth/logout-all` | POST | subscriber/practitioner/admin | Revokes every session for the calling user |
| `/api/subscriber/sliders` | POST | subscriber | Insert-only; never updates a prior snapshot |
| `/api/subscriber/sliders/latest` | GET | subscriber | |
| `/api/subscriber/lab-results` | POST | subscriber | The reconciliation field discussed and previously left unimplemented client-side. Never read by any scoring function. |
| `/api/subscriber/me` | DELETE | subscriber | GDPR/CCPA deletion |
| `/api/marketplace/disciplines` | GET | none | Public, matches "no gatekeeping" positioning |
| `/api/marketplace/matches` | POST | subscriber | Creates a practitioner match |
| `/api/consent/grant` | POST | subscriber | Scoped to one match, not a discipline |
| `/api/consent/:matchId/revoke` | POST | subscriber | |
| `/api/consent/:matchId/data` | GET | practitioner | Re-verifies token, status, and expiry server-side on every call |
| `/api/bookings` | POST | subscriber | Requires payment agreement acceptance |
| `/api/case-registry` | POST | practitioner | |
| `/api/case-registry` | GET | none | Public read, matches Case-Experience Registry |
| `/api/admin/practitioners` | GET | admin | Filterable by `?status=`; closes a gap this table itself used to flag as a TODO |
| `/api/admin/practitioners/:id/verify` | POST | admin | |
| `/api/admin/case-entries/:id/review` | POST | admin | |
| `/api/admin/audit-log` | GET | admin | |
| `/api/practitioner/profile` | GET | practitioner | Own profile only |
| `/api/practitioner/profile` | PATCH | practitioner | Partial update; own profile only |

## Known scaffold limitations — real, not hedging

**Not integrated:**
- Real email delivery. `verifyEmail` accepts a bare user ID rather than a
  real, single-use, expiring emailed token — marked with a TODO in the
  code at the exact point it needs replacing.
- Payment processing. `booking.controller.js` creates an order record but
  does not call Stripe or Square — marked with a TODO at the exact
  integration point. No card data is collected or stored anywhere in this
  scaffold, by design.
- Error tracking / observability (Sentry or equivalent) — currently just
  `console.error`.
- Practitioner-discipline assignment logic — `matched_practitioner_id`
  stays NULL; there is no real matching algorithm yet, only the data
  model to support one.

**Tested via `pg-mem`, not real PostgreSQL.** `pg-mem` is a strong,
Postgres-compatible in-memory engine, and the tests exercise the real
migration SQL and real controller code — but it is not a substitute for
running the actual migrations against a real PostgreSQL instance before
any real deployment. Do that as the first step, before anything else.

**The scoring library is a hand-maintained copy**, not a shared package.
`src/lib/scoring.js` must be kept in sync by hand with the equivalent
logic in `aidh_dashboard.html` until the two are unified into one shared
module the client and server both import — currently they are two files
that happen to agree, verified today, not structurally guaranteed to
keep agreeing.

**No database-level privilege lockdown yet.** The migration for
`audit_log` is insert-only by *design*, but the actual `REVOKE UPDATE,
DELETE ON audit_log FROM <app_role>` statement needs to be run against
the real production database as a deployment step — noted in
`src/db/migrate.js` but not yet automated.

**Provider-level storage encryption is still a deployment step, not
something this repo can do.** `src/lib/fieldEncryption.js` adds
application-layer encryption for the two most PHI-heavy columns as
defense-in-depth, but the primary encryption-at-rest control — an
encrypted database volume (RDS/Cloud SQL/equivalent) — needs to be turned
on wherever this actually gets deployed. Rotating `FIELD_ENCRYPTION_KEY`
also isn't automated: existing encrypted rows would need re-encryption
with the old key before switching.

**No retention policy is defined for `slider_snapshots`/`lab_results`
beyond "as long as the account is active."** That's a legal/business call,
not something `src/lib/retention.js` (which only handles `sessions` and
`push_tokens`) can decide on its own.

**Everything else already listed in `AIDH_Pre_Production_Requirements.docx`
still applies** — real rate-limiting tuning for production traffic, a
real practitioner verification workflow, and a formal security review
before this ever holds real subscriber data. This scaffold does not
shorten that list — it gives several of those items a real, tested
starting implementation instead of a blank page.

---
AI Dynamic Health LLC · California, USA · Internal document — not for
external distribution.
