# AI Dynamic Health — Backend Scaffold

**This is Option 2 from the platform's pre-production discussion: a real,
runnable starting skeleton — not a finished, production-ready backend.**
Read this file before wiring it to anything real.

## What "scaffold" means here, precisely

Every piece of this has been built and genuinely tested — not written and
assumed correct:

- All 5 PostgreSQL migrations run successfully and match
  `AIDH_Database_Design.docx` exactly.
- The scoring library (`src/lib/scoring.js`) is cross-checked against real
  values previously observed in the actual frontend dashboard — same
  pillar weights, same organ-driver calculations, verified to match.
- All 7 route groups (auth, subscriber, consent, marketplace, booking,
  case registry, admin) are implemented with real logic: bcrypt password
  hashing, real JWT issuance and verification, and — the centerpiece —
  server-side re-verification of per-practitioner-match consent on every
  data-access request, not a client-trust shortcut.
- **10 integration tests, all passing**, run against `pg-mem` (an
  in-memory PostgreSQL-compatible engine) executing the real migration
  SQL and the real controller code — including a test that proves the
  database's own CHECK constraint blocks publishing a case entry without
  all three consent confirmations, independent of application code.

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
| `/api/auth/verify` | POST | none | Email verification — see limitations below |
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
| `/api/admin/practitioners/:id/verify` | POST | admin | |
| `/api/admin/case-entries/:id/review` | POST | admin | |
| `/api/admin/audit-log` | GET | admin | |

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

**Everything else already listed in `AIDH_Pre_Production_Requirements.docx`
still applies** — real rate-limiting tuning for production traffic, a
real practitioner verification workflow, legal review of the GDPR/CCPA
deletion flow, and a formal security review before this ever holds real
subscriber data. This scaffold does not shorten that list — it gives
several of those items a real, tested starting implementation instead of
a blank page.

---
AI Dynamic Health LLC · California, USA · Internal document — not for
external distribution.


## AIDH launch integration patch

This connected build adds:
- `GET /ping` and `GET /api/health` health endpoints.
- `GET /api/auth/verify` for server-side JWT validation.
- CORS support for a comma-separated `ALLOWED_ORIGIN` list.
- Frontend API base set to `https://aidh-api.onrender.com`.
- Subscriber signup/sign-in now call the real backend instead of localStorage.
- Email verification is bypassed for the current pre-launch build; registration returns the JWT immediately.

Before deploying, set `DATABASE_URL`, `JWT_SECRET`, and `ALLOWED_ORIGIN` in Render.
Run migrations against the real Supabase PostgreSQL database before testing signup.
