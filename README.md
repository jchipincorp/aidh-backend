# AI Dynamic Health — Backend Scaffold

**This is Option 2 from the platform's pre-production discussion: a real,
runnable starting skeleton — not a finished, production-ready backend.**
Read this file before wiring it to anything real.

## Changelog
**Version 0.7.0 -- a reason for every reported problem, and both people told when a dispute is decided.** Owner decisions of 6 October 2026.

**Dispute reasons (migration 016).** `POST /api/consultations/:id/report-issue` now requires `{ "reason": "<code>" }`, one of: `practitioner_no_show`, `late_or_short`, `technical_problem`, `not_as_booked`, `other`. No free text: anything else is a 400 (`REASON_REQUIRED`, with the list of choices), and any extra field is ignored. Ownership (404) and timing (409) are checked first. The code is stored in the new `consultation_bookings.issue_reason` column, which the database itself limits to those five codes (a CHECK, proven on real PostgreSQL). The wording lives in one place, `src/lib/disputeReasons.js`; the booking page's list is checked against it by a QA test. Deliberately no outcome-based reason ("it didn't help"): the platform makes no outcome claims. The subscriber's `GET /:id` shows `issueReason`; the practitioner's does not. `GET /api/admin/disputes` adds `reason: { code, label }`, or `null` for reports made before this version. The audit line for a report now ends with the code, e.g. `ref 1A2B3C4D (technical_problem)`.

**Decision emails.** Deciding a dispute now sends one dedicated email to each person, "Reported problem: decision (ref ...)", for both outcomes. A refund used to send the generic cancellation email (which never said a dispute was decided); a release used to send nothing. The emails state the decision and the money only: never the reason given or anything either person said. New optional setting **`SUPPORT_EMAIL`**: when set, these emails name it and use it as the reply-to address; when not, they ask people to reply, and replies go to `MAIL_FROM`, so that mailbox must be read. `sendMail` accepts an optional `replyTo` (passed to Resend as `reply_to`). **The wording should be reviewed by counsel** before launch (it is operational, but it concerns refunds).

**Case review: a decision is never applied to a state the reviewer did not see.** Found by the full suite on real PostgreSQL (it had passed three earlier runs): if one reviewer's "Publish" finished just before another reviewer's "Reject" was read, the second request saw a published entry and, correctly by 0.6's rules, took it down; but that reviewer's screen had shown it *waiting*, and they had clicked Reject, not Take down. `POST /api/admin/case-entries/:id/review` now accepts `expectedStatus` (the status the screen showed); if the entry has moved on, it answers 409 "This entry changed since you loaded it (it is now ...)" with `currentStatus`, and changes nothing. The console always sends it. It stays optional for direct API use (the Runbook's curl example). Proven: the new browser check fails against the backend without this. The 0.6.0 backend test "someone else changing the entry between read and write" had the same timing dependence (it failed once in a full run); it now sends `expectedStatus` like the console, and passed 8 of 8 repeated runs.

**Upgrading.** Run `npm run migrate` (applies 016). Older deployments built by the earlier tool still use `--baseline=014_research_feed_topics.sql` first, as before. **One check adjusted on purpose:** `scripts/verify-ops-real-postgres.js` hard-coded 015 as the newest migration in its upgrade check; it now expects every file newer than the baseline (015 and 016), which is what the check always meant.

**Tests:** `npm test` 166/166 (4 new: the reason rules, the admin list's reason, both decision emails and the reply-to, an out-of-date review refused). Existing tests that reported a problem now send a reason. Real PostgreSQL: 44 + 21 + 6 + 36, unchanged.

**Version 0.6.0 -- admin screens for case-entry review and disputes; admin duties enforced on them; a dispute can be decided only once.**

**New endpoints.** `GET /api/admin/case-entries?status=pending_review|published|rejected|all` (default pending): the review queue, priority-review entries first then oldest first (others newest first), at most 200 per call (`truncated: true` if more). Each entry carries the decrypted case text (the reviewer must read it), the practitioner's name or code, the discipline, the three consents and `missing_consents`. An entry whose text cannot be decrypted (for example after a key change) is listed with `decrypt_failed: true`, never hidden. `GET /api/admin/disputes?state=open|resolved|all` (default open): bookings a subscriber reported a problem with, oldest report first (others newest first), with the amounts, the outcome (`refunded` / `released`), and both parties' emails, because deciding fairly means contacting both. Nothing about anyone's health is in a booking.

**Admin duties are now enforced (new `requireAdminRole` in `src/middleware/auth.js`).** The three `admin_users.admin_role` values existed but nothing checked them. Case review (list and decide): `super_admin` and `case_reviewer`. Disputes (list and decide, including the existing `POST /api/consultations/admin/:id/resolve`): `super_admin` and `support`. A token with the `admin` role but no `admin_users` row is refused (403, `NOT_ADMIN_ACCOUNT`); the wrong duty gets 403 `ADMIN_ROLE_NOT_ALLOWED` with the allowed roles. **Not yet applied** to the practitioner list, verification, audit log or Research Feed admin routes: those still accept any admin (an owner decision; see the frontend README).

**`POST /api/admin/case-entries/:id/review`, stricter.** An unknown or malformed id is 404 (it used to answer 200 with an empty body). Publishing an entry without all three consents is a 409 naming what is missing (it used to reach the database CHECK and come back as a 500). Already in that state: 409. If someone else changed the entry between read and write: 409 (the update is conditional on the status it read). Notes are trimmed and capped at 2,000 characters. A published entry can be taken down (rejected) and a rejected one reconsidered. Every decision is audited (`CASE_ENTRY` / `PUBLISHED`, `UNPUBLISHED`, `REJECTED`) with the entry's short reference and the change only: never the case text or the case code. `reviewed_by` is the reviewer's `admin_users` id.

**Bug fixed: a dispute could be refunded AND paid.** Two admins deciding the same dispute at the same moment (one refund, one release) could both pass the "is it still disputed?" check; the release update had no status guard, so the booking was refunded and then set back to `completed`, and the payout job paid the practitioner too. Reproduced against the previous code in a test (both answered 200; refunded=true, paid=true). Now the decision is claimed first with a conditional update, the second admin gets 409, and if Stripe's refund call fails the claim is undone so the dispute can be decided again. **Also fixed:** a refund decision never set `issue_resolved_at`; it now does. Older refunded disputes are still shown as decided (by status).

**One existing test changed on purpose.** `tests/consultations.test.js`, dispute test: its admin was a user with `role = 'admin'` and no `admin_users` row, which the resolve route now correctly refuses; the test now gives that admin a `support` row. Nothing else in it changed.

**Tests:** `npm test` 162/162 (8 new in `tests/admin_review_and_disputes.test.js`: who may use each screen; queue order and content; every refusal leaving the entry untouched; publish, take down and reconsider audited without case text; two simultaneous reviews; an undecryptable entry listed and flagged; the dispute list, refund and release with outcomes and only the released one paid; two admins at once; a failed Stripe refund leaving the dispute open). Both concurrency tests were run against the previous code and fail there. Real PostgreSQL, real browser, real concurrency: `admin_review_disputes_e2e_test.js` 40/40 in the QA harness. Earlier real-Postgres checks unchanged (44/44, 21/21, 6/6, 36/36).

**Version 0.5.0 -- the operations layer: tracked migrations and seeds, safe production defaults, readiness, graceful shutdown, a payout-job heartbeat.**

**Supersedes earlier warnings.** Several entries below say "do not re-run `npm run seed`" or that `npm run migrate` must only be run once. Both are now safe: the runners remember what they have applied.

**Migrations (`src/db/migrate.js`).** Applied migrations are recorded in `schema_migrations` (name and checksum). Each migration runs in its own transaction (a failure leaves nothing behind and is not recorded); an applied migration that was edited afterwards is refused; a database advisory lock stops two deploys interleaving. `npm run migrate:status` shows applied / pending / altered and changes nothing. A database created by the EARLIER tool (tables, no history) is refused with instructions: `npm run migrate -- --baseline=<last migration already applied>` adopts it without re-running anything (for a v0.4 database: `--baseline=014_research_feed_topics.sql`, which then applies 015). Proved on a real PostgreSQL: the previous tool failed on a second run ("type already exists").

**Seeds (`src/db/seed.js`).** Recorded in `schema_seeds`. Content seeds (the Research Feed items, the Fasting and Diet videos) run ONCE, so an item an admin deletes never comes back. Reference data (the marketplace disciplines, marked `-- @rerunnable`) is applied every time. A content seed edited after it was applied is not re-run (a warning says so). A database seeded by the earlier tool is refused until `npm run seed -- --baseline`.

**Safe production defaults (`src/server.js`).** In production the server refuses to start unless `ALLOWED_ORIGIN` is a real origin (unset and `*` are both refused: the old `.env.example` shipped `ALLOWED_ORIGIN=*`, which the previous check accepted) and `TRUST_PROXY` is set (the number of proxies, or `false`; `true` is refused because it trusts a forged `X-Forwarded-For`). Without `TRUST_PROXY` behind a load balancer the rate limiter would see every visitor as the proxy's address.

**Health.** `GET /api/health` is liveness (never touches the database). `GET /api/ready` is readiness: 503 if the database does not answer within 2 seconds or the process is shutting down; otherwise 200 with `jobs`: `never-run`, `ok`, `stale` (nothing finished within `JOBS_STALE_AFTER_SECONDS`, default 900) or `failing`. Alert on `stale` and `failing`: the payout job releases practitioners' money. Both endpoints are registered before the rate limiter, so monitoring can never be throttled.

**Graceful shutdown.** SIGTERM / SIGINT: stop taking requests, finish those in flight, close the database pool, exit 0 (forced exit after 15 seconds).

**Payout-job heartbeat (migration 015).** Every pass of `runConsultationJobs` records `job_heartbeats`; a failed pass is recorded and still throws. The summary holds no personal data.

**Also.** `.env.example` rewritten with every setting the code reads and its true default; `engines: node >=22`; CI runs the new operations verification.

**Tests.** `npm test` 154/154 (15 new: production safety checks, readiness, heartbeat states). `npm run verify:ops-real-postgres` 36/36 against a real PostgreSQL with real server processes (fresh, repeat and new-file migrations; edited and failing migrations; upgrading a v0.4 database; two simultaneous deploys; seeds run once, not resurrecting a deleted item, legacy baseline; the server refusing four unsafe production configurations; readiness, the heartbeat's ok / stale / failing, 340 readiness checks not throttled, SIGTERM exit 0, and a database dropped under a running server giving 503 on readiness and 200 on liveness). It leaves no databases behind.

**This version -- seed for one Diet-tab video (`src/db/seed/seed_research_feed_diet.sql`).**

Same design as the Fasting seed: a separate, idempotent file (a video already present, matched by its link, is not inserted twice; its Diet tag is not duplicated). One `youtu.be` link stored without the `?si=` share-tracking code; published; not featured on the homepage; tagged `diet` only. Title "Dr. William Li" (an inference from the supplied transcript, to be confirmed: see the frontend README) and one neutral caption written from the transcript, which deliberately repeats none of the talk's own health claims. `npm run seed` applies it (file order: diet before fasting, independent). **On an already-running database do not re-run `npm run seed`**; run only this file: `psql "$DATABASE_URL" -f src/db/seed/seed_research_feed_diet.sql`. Verified against a real PostgreSQL (14 items, 5 Fasting tags, 1 Diet tag after the full seed; unchanged after running both new files twice more); its content is guarded by `tests/seed_diet_video.test.js`.

**Tests:** `npm test` 143/143 (3 new: the exact link as a bare video address with no tracking code in the SQL itself; safe to run twice, Diet tag only, not featured; the caption is one neutral sentence with no digits, outcome or disease words). Real PostgreSQL 44/44 and 21/21.

**This version -- seed for five Fasting-tab videos (`src/db/seed/seed_research_feed_fasting.sql`).**

A separate seed file so `seed_research_feed.sql` (eight items, plain inserts, run once) is untouched. This file is idempotent: a video already present (matched by link) is not inserted again and its Fasting tag is not duplicated. Five `youtu.be` links stored without the `?si=` share-tracking code, published, not featured on the homepage, tagged `fasting` only, with PLACEHOLDER titles ("Fasting video 1".."5") and the single neutral caption "A third-party video about fasting, shared for education and information only." (the speakers and content are not known: see the frontend README for how to replace them). `npm run seed` applies it after the original (file order). **On an already-running database do not re-run `npm run seed`** (the original seed would duplicate its eight items); run only this file: `psql "$DATABASE_URL" -f src/db/seed/seed_research_feed_fasting.sql`. The pg-mem test harness loads only the disciplines seed, so this file is verified against a real PostgreSQL (13 items and 5 Fasting tags after the full seed; unchanged after running the file twice more) and its content by `tests/seed_fasting_videos.test.js`.

**Tests:** `npm test` 140/140 (3 new: the exact five links as bare video addresses with no tracking code in the SQL itself; safe to run twice, Fasting tag only, not featured, placeholder titles not invented; the caption carries no numbers or outcome words). Real PostgreSQL 44/44 and 21/21.

**This version -- Research Feed "By approach" tags (migration 014), link and type validation.**

New table `research_feed_item_topics` (item_id, topic_id) with a CHECK on `protocols, yoga, meditation, tcm, fasting, diet`, separate from the five pillars (migration 008's CHECK stays as it was). `GET /api/research-feed` and `GET /api/admin/research-feed` return `topics` beside `pillars`. `POST` accepts `topics` (and `pillars` is now optional): an item needs at least one pillar OR one approach. `PATCH` replaces whichever set is sent and refuses (before changing anything) an update that would leave the item with no tags. `url` and `thumbnailUrl` must be full http(s) addresses (a `javascript:`, `data:` or `ftp:` value, markup, a space or a bare word is refused, on create and on update). `itemType` stays open-ended but must be a short lowercase word (video, paper, article, document...). Only an `itemType` of `video` can be `featuredOnHomepage` (create and update), because the homepage row is a row of YouTube videos. The ids are in three places that must match (the controller's `VALID_TOPICS`, the page's `TOPICS`, the admin form's `.rf-topic-cb`); the frontend guard cross-checks the last two and the backend tests the first.

**Tests:** `npm test` 137/137 (8 new in `tests/research_feed.test.js`: approach-only items and both arrays in the public list; all six ids accepted, unknown refused, duplicates collapsed; at-least-one-tag rule on create; update replaces/keeps/refuses without changing anything; the link rules incl. `javascript:`; the type rule; cascade delete and drafts never public; only videos on the homepage). Real PostgreSQL: migration 014 applies and the database itself refuses an unknown approach; 44/44, 21/21 and 6/6 still pass. Real browser, real admin form: `research_feed_topics_e2e_test.js` 26/26 (in the front-end test harness).

**This version -- tools for the Stripe test-mode run (read `STRIPE_TEST_RUN.md`).**

`npm run stripe:check-env` (read-only pre-flight; refuses live keys, and sends nothing to Stripe if it sees one; checks the test key, the webhook secret, that Stripe is reachable in test mode, that Connect is enabled, the migrations, and notes the settings to change for the run). `npm run verify:stripe-run` (read-only; for every paid booking compares our records with Stripe's: payment succeeded, amount and currency, metadata tie-back, charge id, our recorded fee vs Stripe's fee, refunds vs our recorded refund, and for a released booking the transfer's amount, destination, source charge and reversal; exits 1 on a mismatch). `npm run seed:test-practitioner` (a verified test practitioner; refuses anything that is not a local or test database or that has a live key). `npm run local-stack -- --frontend <folder>` (serves the pages and the REAL-Stripe API on one address, because the pages call the API at the address they are served from; refuses production and live keys). `npm run jobs:consultations` (one pass of the release job). Library: `src/lib/stripeRunCheck.js`.

**Tests:** `npm test` 129/129 (new `tests/stripe_run_check.test.js`: a live key stops everything before any Stripe call; placeholder keys and a missing webhook secret are reported; Connect disabled, a live-mode reply and an unmigrated database are each reported; the reconciler passes a clean booking and catches a wrong fee, a wrong amount, a booking tied to another payment, a payment that did not succeed, a refund that differs from the recorded one, a failed refund not counting, and a transfer with the wrong amount, destination or a reversal). The simulated Stripe gained `refunds.list`, `transfers.retrieve`, `balance.retrieve` and `accounts.list`.

**Not run against the real Stripe API** (the build environment cannot reach it): the first real run tests these tools as much as the product. **Known issue found while preparing:** account creation passes no country, so a practitioner outside the US cannot onboard; see open item 12 in the frontend README.

**This version -- Practitioner Agreement acceptance (migration 013).**

A practitioner is not bookable, listed or offered slots until they have accepted the current agreement version. `practitioner_booking_settings` gains `agreement_version` and `agreement_accepted_at`; `consultation_bookings` gains `practitioner_agreement_version` (the version in force when the booking was made). The current version is `PRACTITIONER_AGREEMENT_VERSION` (default `DRAFT-1`, a clearly marked placeholder until counsel's final text exists); change it and everyone must accept again, while existing bookings are untouched. New endpoints: `GET /api/consultations/agreement` (public: the version and whether it is a draft) and `POST /api/consultations/agreement/accept` (practitioner only; needs `accept: true` and the exact current version; idempotent, so the first acceptance time is kept; audited as `AGREEMENT_ACCEPTED`). `GET /api/consultations/settings` now reports an `agreement` block and the reason `agreement_not_accepted`. **Before real use:** set `PRACTITIONER_AGREEMENT_VERSION` to the final version when counsel's text is ready, and change it in the agreement page and the console too (see open item 11 in the frontend README).

**Tests:** `npm test` 120/120 (new `tests/consultations_agreement.test.js`: the public version and draft flag; the agreement being the only missing item; wrong, missing and stale versions refused; only a practitioner can accept; accepting is recorded, audited and idempotent; a new version forces re-acceptance without touching an existing booking; each booking records the version). Real PostgreSQL: consultations 21/21 (new checks that a practitioner with everything else ready is not bookable or listed until they accept), 44/44 and 6/6.

**This version -- match requests retired too, so the purge stays clean.**

`POST /api/marketplace/matches` now returns HTTP 410 (`MATCH_REQUESTS_RETIRED`) after the sign-in and role checks, unless `AIDH_LEGACY_MATCHES=true`. Only the inert consent system's tests set that, because its records are tied to matches; production should leave it off. The dashboard no longer calls it. With counsel's advice to include match requests, the runbook is: back up, `npm run purge:legacy-requests -- --include-matches` (dry run), then `npm run purge:legacy-requests -- --confirm --include-matches`, then run the dry run again to see zeros, then deal with the pre-purge backup (it still holds the old requests).

**Tests:** `npm test` 114/114 (new: match creation is off by default and refused after sign-in and role checks). Real PostgreSQL: 44/44 (new check that a match request is refused by default; the script then opts in for its consent checks), 19/19 and 6/6; the purge run with `--include-matches` against a real database with seeded rows took one booking request, one order and one match request to zero and wrote one audit entry.

**This version -- old booking requests retired and purgeable; counsel's refund wording in the emails.**

`POST /api/bookings` now returns HTTP 410 after the sign-in and role checks, so request-based bookings (contact details, preferred times and free-text notes) can no longer be created. That also closes the old IDOR on that endpoint. `npm run purge:legacy-requests` is a dry run that counts what would be deleted; `npm run purge:legacy-requests -- --confirm` deletes booking requests and their orders (irreversible: back up first), and `--include-matches` also deletes match requests. Each real purge writes an audit entry. The confirmation and cancellation emails use counsel's refund wording ("a refund of the consultation fee paid, less the third-party payment processing fee incurred").

**Tests:** `npm test` 113/113 (the IDOR test now asserts the retirement; new tests for retirement and for the purge: dry run deletes nothing, confirm deletes booking requests and orders but not match requests, include-matches deletes those too, each purge is audited, an empty database is harmless). Real PostgreSQL: 43/43 (the IDOR check changed the same way), 19/19 and 6/6; and the purge script itself was run against a real database with seeded rows (the dry run deleted nothing; confirm removed the booking request and its order, left the match requests and wrote one audit entry). The obsolete browser test of the old booking form is archived in the build harness and not shipped.

**This version -- backend for booking steps 2A and 2B: fee-deducting refund, public directory with headshots, Resend, and a practice server.**

**Refund (owner decision).** A subscriber who cancels more than 24 hours before the session is refunded the payment minus the card-processing fee Stripe charged (read from the balance transaction, and fetched at cancellation if the earlier lookup failed; if Stripe cannot say, nothing is cancelled and no refund is attempted). Within 24 hours: no refund. Practitioner cancellations, a double-booked late payment, and refunds an admin chooses after a reported problem: full refund (AIDH bears Stripe's fee on those). `CONSULTATION_REFUND_DEDUCTS_FEE=false` restores a full refund for subscribers. `GET /api/consultations/:id` now returns a `cancellation.refund` preview (`full_minus_fee` with the exact amounts, `full`, or `none`) so the page can show the figure before the button is pressed.

**Public directory (migration 012).** A practitioner is listed only with an explicit, timestamped consent (`directory_consent_at`), a name, verification, and the usual booking requirements. Cards carry display name, credentials (qualifications and registration body), location, bio, prices and a headshot path. Headshots: the browser crops and shrinks them; the server accepts only a real JPEG up to 100 KB, strips EXIF/XMP/IPTC/comment segments, stores it as base64, and serves it publicly only for a verified, consenting practitioner (with `Cross-Origin-Resource-Policy: cross-origin`, because the pages live on another origin). Withdrawing consent hides the listing and the photo immediately. No moderation of photo content.

**New endpoints:** `GET /terms`, `GET /quote/:practitionerId` (the exact price this subscriber will pay), `PUT|DELETE /photo`, `GET /photo/mine`, `GET /practitioners/:id/photo`; settings accept `directoryConsent`; `GET /mine` and `GET /:id` carry the practitioner's name; `GET /practitioner/bookings` carries `refundCents`. **Resend (`src/lib/mailer.js`):** `MAIL_PROVIDER=resend` with `RESEND_API_KEY` and `MAIL_FROM` (a sender on a domain verified in Resend); never throws, never logs addresses or bodies; tested against a mocked network only. **Practice server:** `node scripts/dev-fake-stripe-server.js` runs the real backend with a pretend Stripe and `/dev` pages (a fake checkout with a Pay button, a fake payout setup, and a button to run the jobs N hours ahead). It refuses to start in production.

**Tests:** `npm test` 110/110 (was 91): refund preview and amounts, the switch, the fee fetched or unavailable, directory consent and listing, headshot validation and EXIF stripping, public photo access, terms and quote, name on bookings, the Resend adapter (request shape, rejection, network failure, missing key), JPEG sanitiser and `refundAfterFee`. `npm run verify:consultations-real-postgres` 19/19 on REAL PostgreSQL (now includes the directory, headshot and refund-minus-fee); the earlier real-Postgres checks are unchanged (42/42, 6/6). **Still not proven:** Stripe's real API and Resend's real service.

**This version -- consultation booking, Phase 1 (backend only): hold-and-release payments, shared video link with safeguards, Stripe Connect onboarding. No page uses it yet; do not expose it until Phase 2 and the policy updates (see "Before enabling").**

**Decisions this implements** (product owner): start with the practitioner's own shared video link plus safeguards (not per-booking links); charge at booking, hold, release after the session (not an instant split); Stripe's processing fee comes out of the practitioner's 75% share, so AIDH's 25% of the gross is never reduced; no minimum session price.

**Flow.** Practitioner sets price (and an optional lower Premium price), session length, time zone, weekly availability, a video link, and completes Stripe Express onboarding -> a subscriber picks a time, which is HELD for 15 minutes (a UNIQUE `slot_key` makes double-booking impossible at the database) and a Stripe Checkout session is created -> Stripe's webhook (`checkout.session.completed`, via the existing `/api/billing/webhook`) confirms the booking, records Stripe's fee from the balance transaction, and emails both people -> 24 hours after the session ends, unless the subscriber reported a problem, a job transfers the practitioner's share (75% of gross minus Stripe's fee) tied to the original charge, with an idempotency key so a retry can never pay twice.

**Shared-link safeguards.** https only, no embedded credentials, real hostname, any provider; setting or changing it requires the practitioner's confirmation that they admit each person individually (`hostAdmitsAck`), timestamped, and it expires after 90 days (the practitioner stops being bookable until re-confirmed). The link is revealed only to the booked subscriber and that practitioner, only once the booking is paid, and never appears in any listing endpoint. Confirmation emails carry the link and booking details only -- never health information. The practitioner receives the booked subscriber's email for that booking so they can recognise who is asking to join (`SHARE_SUBSCRIBER_EMAIL=false` withholds it).

**Defaults (all overridable by environment variable; please confirm):** hold 15 min (`CONSULTATION_HOLD_MINUTES`); earliest booking 12 h ahead (`CONSULTATION_LEAD_HOURS`); horizon 30 days; free cancellation until 24 h before (`CONSULTATION_FREE_CANCEL_HOURS`), none after, full refund whenever the practitioner cancels; release 24 h after the session ends (`CONSULTATION_RELEASE_DELAY_HOURS`); link re-confirmation every 90 days. A late payment after a hold lapsed re-takes the slot if free, otherwise is refunded automatically.

**Endpoints (`/api/consultations`):** public `GET /practitioners`, `GET /practitioners/:id/slots`; practitioner `GET|PUT /settings`, `PUT /availability`, `POST /connect/onboard`, `GET /connect/status`, `GET /practitioner/bookings`, `POST /:id/complete`; subscriber `POST /book`, `GET /mine`, `POST /:id/report-issue` (body `{ reason }`, one code from the fixed list); both parties `GET /:id`, `POST /:id/cancel`; admin `POST /admin/:id/resolve` (refund or release a reported problem; both people are emailed the decision). Account deletion is refused (409) while a paid booking's money is in flight.

**Tests:** `npm test` 91/91 (was 60): 8 pure-logic tests (fee split, payout, cancellation policy, link rules, time zones including a daylight-saving change, slot generation) and 23 endpoint tests (slot guard and a concurrent race, money, Premium price, link visibility, cancellation, late payment, release and idempotency, disputes, role and ownership checks, account deletion). `npm run verify:consultations-real-postgres` 16/16 against REAL PostgreSQL (slot race, slot freed and re-booked, money, one-time release); earlier real-Postgres checks unchanged (42/42, 6/6).

**What this does NOT prove.** Stripe is a FAKE in every test and in the real-Postgres script: they prove our logic and SQL, not that Stripe's real API accepts these exact calls. Before launch, run the whole flow once against a Stripe TEST account, specifically: Checkout creation, the `latest_charge.balance_transaction` expansion used to read the fee, `transfers.create` with `source_transaction` (including to a practitioner in another country -- Connect availability and payout rules vary by country), and refunds.

**Known gaps / decisions still open:** refunds do not return Stripe's processing fee, so AIDH bears that sunk cost on refunded bookings; Stripe's Connect per-account and payout fees are billed to AIDH and are not modelled; no calendar sync, no buffer between sessions, no rescheduling (cancel and re-book); no admin screen for disputes (the endpoint exists); chargebacks after release and practitioner-account deletion with held funds are not handled; one currency per practitioner; the older request-based `booking_requests` flow still exists until the frontend moves over.

**Before enabling:** (1) Stripe: enable Connect (Express) and add `checkout.session.completed` and `checkout.session.expired` to the webhook's events; set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. (2) Email: no provider is wired in yet -- `MAIL_PROVIDER` supports `console` (development) and `outbox` (tests) only; an adapter is a small function in `src/lib/mailer.js` once one is chosen. (3) Schedule `node scripts/run-consultation-jobs.js` every few minutes (or set `CONSULTATION_JOBS_INTERVAL_MS`). (4) Set `CONSULTATION_RETURN_URL` and `CONNECT_RETURN_URL` to real page addresses. (5) Build Phase 2 (frontend) and update the Privacy Policy and Terms first. **Status: the screens (steps 2A and 2B) are built and tested against a pretend Stripe. Do not open booking to the public until the legal wording (2C) is done and one run against a Stripe test account has passed. The full list is open item 9 in the frontend README.** **Before launch, back up the database and run the purge of old requests, as counsel advised: `npm run purge:legacy-requests -- --include-matches` shows what would be deleted; `npm run purge:legacy-requests -- --confirm --include-matches` deletes it (irreversible). The full runbook, including what to do with the pre-purge backup, is in the frontend README.**

**This version -- migration 010 drops the unused `subscriber_profiles.date_of_birth` and `gp_name` columns, with a safety check.**

Nothing in `src` or `tests` reads or writes either column and no query uses `SELECT *` on the table, so neither was ever returned to a client; they were empty in any database built from this code. The migration's `DO` block refuses to run, and drops nothing, if any row holds a value (review, export or clear it, then re-run). The in-memory test engine has no PL/pgSQL, so `tests/setup.js` skips that block (as it already skips `CREATE EXTENSION`), and the safety check is verified against REAL PostgreSQL by `npm run verify:drop-pii-columns` (6 checks: refuses with a value planted and leaves everything intact; runs once cleared; columns gone; other columns untouched).

**Tests:** `npm test` 60/60 (was 58): `tests/drop_unused_columns.test.js` confirms the columns are gone and the columns the platform uses remain. `npm run verify:real-postgres` 42/42 (was 41): it now asserts that slider storage is refused by default, then enables it for the rest of its checks. The full migration chain 001-010 was applied from scratch to a fresh real PostgreSQL database.

**This version -- health inputs and scores are no longer stored or released by the server (`AIDH_STORE_HEALTH_DATA`, default off).**

New middleware `src/middleware/healthData.js`. With `AIDH_STORE_HEALTH_DATA` unset or not `true`, these routes answer HTTP 410 `HEALTH_DATA_NOT_STORED` and write or release nothing: `POST /api/subscriber/sliders`, `GET /api/subscriber/sliders/latest`, `POST /api/subscriber/lab-results`, and the practitioner data-release route `GET /api/consent/:practitionerMatchId/data`. Authentication and role checks run first (no token is a 401, never a 410). The variable is read on every request, defaults to off, and setting it to `true` is the single explicit way to turn storage back on (for example a future, opt-in Premium sync). Account deletion, billing, marketplace matching and booking are unaffected. Consent grant/revoke endpoints and tables remain but are inert, since the data-release route is refused.

**Tests:** 58/58 (was 51). `tests/health_data_off.test.js` adds 7: each gated route returns 410 and the database stays empty (`slider_snapshots`, `computed_scores_cache`, `lab_results` all zero); authentication still wins over the 410; account deletion still works; turning the variable on restores the previous behaviour. `tests/consent.test.js` exercises those routes by design and opts in explicitly at the top of the file.

**Note for anyone running the wider browser/e2e suites against this backend:** the auth routes allow 20 requests per 15 minutes per IP, so restart the backend between suites.

**This version — a new `featured_on_homepage` column on `research_feed_items`, connecting the Research Feed table to aidh_website.html's own video row for the first time.**

Migration 009 adds the column, defaulting false -- an admin must explicitly opt an item in, not have every published item automatically reach the website. `researchFeed.controller.js`'s `list()`, `listAll()`, `create()`, and `update()` all read/write it now; `list()` (the public endpoint) returns it so the website's own frontend fetch can filter on it client-side.

**The seed data grew from 5 items to 8**, not from new content but from closing a real gap: three videos (Jasvinder Singh/Dystonia, a Jind, Haryana participant, Narhari Pandya) had been added to aidh_website.html by hand across several earlier sessions, with no corresponding row in this table at all. Added as real seeded rows, captions copied verbatim from the website's own existing HTML, all marked `featured_on_homepage = true` alongside the original five, so the website's new live fetch (aidh_website.html, this same change) has real data to show from the moment this seed applies, rather than silently losing three videos the moment the website stopped using hardcoded HTML.

**A pre-existing test (`research_feed_e2e_test.js`, in the frontend test harness) failed three checks after this seed change** -- all three hardcoded the old 5-item baseline. Investigated directly rather than dismissed or left failing: updated the baseline to 8 (and the post-create check from 6 to 9), the correct, current count, not a workaround.

Verified: migration and seed both apply cleanly from scratch; the public endpoint confirmed to return `featured_on_homepage` correctly for all 8 seeded items via a direct curl check. Full backend suite re-run: 51/51 (unchanged -- this column isn't yet exercised by this suite's own dedicated tests, since the real verification for it lives in the frontend harness's `research_feed_e2e_test.js`, now 10/10).

**This version (v0.5) — `research_feed_items` gains `featured_on_homepage` (migration 009), the explicit, admin-controlled bridge between this table and `aidh_website.html`'s own Chapter 3 video row, which previously had no connection to this table at all.**

**Why this is a real schema change, not just a cosmetic flag.** Before this, the website's video row and this table were genuinely independent: the Research Feed page reads this table; the website's row was static HTML with no backend connection whatsoever. Three videos added to the website across this project (Jasvinder Singh/Dystonia, a Jind, Haryana participant, Narhari Pandya) were never added here either -- `seed_research_feed.sql` is rewritten in this version to include all eight, not the original five, with `featured_on_homepage = true` on every one of them, matching what was already live on the website before this change (so applying this migration against an existing deployment does not silently remove anything that was already showing).

**`list()` and `listAll()` now both return this column**, so the public endpoint can be filtered by it client-side (the website's own fetch does exactly this) and the admin UI can display and toggle it per item. **`create()` and `update()` both accept `featuredOnHomepage`** (defaults to `false` on create -- an admin must deliberately opt an item in, not an automatic consequence of publishing), validated and stored the same way `published` already is.

Verified: full backend suite re-run after the migration and controller changes: 51/51, including the 9 pre-existing research-feed tests (none needed modification -- this is a strictly additive column, not a breaking change to anything they check). Real-Postgres verification (`scripts/verify-real-postgres.js`): 41/41. Also verified directly against the real frontend consuming this endpoint: a real admin-created item with the flag set was confirmed to appear on the live website with no code change required on either side, and toggling the flag off was confirmed to remove it -- see the corresponding frontend changelog entry for the full real, end-to-end workflow this enables.

**This version (v0.4) — the Research Feed's admin upload capability, built real: a new table, a public read endpoint plus admin-gated create/update/delete, the platform's existing five videos migrated in as real rows, and a secure out-of-band admin provisioning script.**

**What this completes.** `aidh_research_feed.html` (built in a prior session) shipped with its five items hardcoded directly in the page, with the admin-upload capability explicitly deferred as future work. This is that future work: migration 008 (`research_feed_items` + a `research_feed_item_pillars` junction table, since an item typically carries more than one pillar tag), `researchFeed.controller.js`, `routes/researchFeed.routes.js` (a public router at `/api/research-feed`, no auth; an admin router at `/api/admin/research-feed`, `requireAuth`+`requireRole('admin')`, the exact same pattern as every other `/api/admin/*` route), and the five existing videos migrated into `seed/seed_research_feed.sql` as real rows -- not re-invented content, the same video IDs, captions and pillar tags already live on the page.

**Admin accounts are never self-service.** `scripts/create-admin.js` creates a real admin account (reusing `BCRYPT_ROUNDS` from `auth.controller.js`, not a separately chosen hashing cost) and refuses a password under 12 characters or an email that already has any account. There is still no API endpoint that creates an admin account, and there should never be one.

**A real, reproducible pg-mem-specific bug found and fixed while writing the test suite, not worked around.** `WHERE item_id = ANY($1::uuid[])` -- the natural way to batch-look-up pillar tags for several items at once -- silently returned zero rows in the pg-mem test harness specifically when the column is a foreign-key-referenced uuid whose value came from a separate SELECT, even though the exact same values matched correctly with a plain `=`. Confirmed this was a test-harness-only issue, not a real bug, by running the original query against real Postgres directly: it worked correctly there (this is also now covered by `scripts/verify-real-postgres.js`). Rather than leave a test-only workaround that masked the real code's own query, replaced the query itself with a dynamic `IN ($1,$2,...)` list -- confirmed correct against both pg-mem and real Postgres, so the application code is what's actually portable, not a special-cased test path around it.

**Draft vs. published, by design.** A new item defaults to a draft (`published=false`) unless an admin explicitly sets `published:true` in the same request; the public endpoint only ever returns published items, so a draft can never leak onto the public page by a race or an oversight -- confirmed directly, not assumed: the automated suite creates a draft, confirms it is absent from the public endpoint while present on the admin list, publishes it, confirms it is now present, deletes it, confirms it is gone from both.

Verified: 9 new automated tests (`tests/research_feed.test.js`) covering the public endpoint needing no auth, both admin-auth boundaries (no token at all; a real but non-admin token) on every admin route, input validation (missing fields; an unknown pillar id), the full draft-to-publish-to-delete lifecycle, that updating pillars replaces the full set rather than merging with the old one, 404s on a nonexistent id (not a silent success), and that create/update/delete each write a real audit_log row. Full suite: 51/51. Real-Postgres verification (`scripts/verify-real-postgres.js`): 41/41. Also verified manually against real Postgres end to end before the automated suite existed: create a draft, confirm hidden from public, publish, confirm visible, delete, confirm gone everywhere -- matching exactly what the automated suite now checks permanently.


**This version (v0.3) — a free plan label, ONE free trial per account, and a double-billing bug fixed.**

- **New accounts are `free`, not `trial`.** `register()` used to write `plan='trial'` and a 7-day `trial_ends_at` for every subscriber, a leftover from when everyone got a trial on sign-up. Nothing enforced it, but every free account looked like an expiring trial in `GET /api/billing/status` and in any admin view. Now `plan='free'` with no `trial_ends_at`. The `subscriber_plan` enum gained `free` (base schema, `001_users_and_identity.sql`); `trial` stays in the enum only so old rows remain valid.
- **One free trial per account.** Every subscription this app has created began with a 7-day trial, so a `subscriptions` row existing at all means the trial has been used. First `POST /api/billing/subscribe` gets `trial_period_days: 7`. Anyone who has subscribed before (a canceled row) and starts again gets **no trial and is charged immediately**. `GET /api/billing/status` now also returns `trialAvailable` so the UI can say so.
- **A failed immediate charge cannot leave a half-created subscription.** The no-trial path creates the Stripe subscription with `payment_behavior: 'error_if_incomplete'`. Without it Stripe creates the subscription anyway in an `incomplete` state, which our `subscription_status` enum has no value for, so we would have written a database error *after* a live Stripe subscription existed. A declined card now returns `402` with Stripe's message and records nothing; the person can try again with another card.
- **Bug fixed: subscribing twice created two Stripe subscriptions.** `subscribe()` had no check for an existing live subscription, so calling it again returned `201` and billed the person twice. It now returns `409` and creates nothing at Stripe.
- **Cancel and the `customer.subscription.deleted` webhook return the plan label to `free`** (they used to leave `monthly`/`annual` on an account with no subscription).
- Audit action for a restart is `SUBSCRIPTION_STARTED_NO_TRIAL` (first-time is still `TRIAL_STARTED`).

**Upgrading an EXISTING database** (a brand-new one needs nothing; `npm run migrate` creates `free` already): `DATABASE_URL=postgres://... node scripts/upgrade-free-plan.js`. It adds the enum value, makes `free` the default, and converts never-subscribed `trial` accounts and canceled-subscription accounts to `free`; live subscriptions are untouched; safe to run twice. It is a script rather than a numbered migration because Postgres will not let a new enum value be used in the same batch that adds it, and the migration runner applies each file as one batch. (Verified against real Postgres starting from the original schema with realistic old data.)

Tested: 6 new tests (`tests/free_plan_single_trial.test.js`, real controllers + a Stripe-like stateful fake), full suite 42/42, real-Postgres verification 41/41. What this cannot prove is Stripe's real behaviour for an immediate-charge subscription (declines, 3-D Secure); that needs real Stripe test-mode keys (see the activation checklist below), and a test card that requires authentication should be tried before go-live.


**This version — real Stripe subscription billing for the 7-day-trial-then-charge flow**, closing a gap found and precisely audited in an earlier pass (confirmed then: no processor SDK anywhere, the payment form only validated card format and discarded it, and the `subscriptions` table — though well-designed — had zero code touching it).

**New: `src/lib/stripeClient.js`, `src/controllers/billing.controller.js`, `src/routes/billing.routes.js`.** Uses Stripe's own trial primitive (`trial_period_days` on a subscription) rather than a hand-rolled scheduler — Stripe's infrastructure handles the actual charge timing and the "don't charge if canceled before trial end" behavior correctly; this code's job is creating the right Stripe objects and staying in sync with what Stripe reports back via webhook, not reimplementing a billing state machine Stripe already solves.

- `POST /api/billing/setup-intent` — creates/reuses a Stripe customer and a SetupIntent (collects a card via Stripe Elements client-side, charges nothing)
- `POST /api/billing/subscribe` — creates the real trialing subscription once the payment method is confirmed; this is what actually starts the 7-day trial
- `POST /api/billing/cancel` — cancels the caller's own subscription immediately if still trialing, meaning Stripe never creates an invoice for it — genuinely no charge, not just a UI promise
- `GET /api/billing/status` — reads from the local `subscriptions` table, never a live Stripe call
- `POST /api/billing/webhook` — keeps `subscriptions.status`/`current_period_end` in sync with `customer.subscription.updated`/`.deleted`, `invoice.payment_succeeded` (the real day-8 charge succeeding), `invoice.payment_failed`

**A classic, easy-to-get-wrong Express+Stripe detail handled correctly and documented, not just fixed silently:** the webhook route needs the raw, unparsed request body for signature verification, but the app's global `express.json()` would otherwise consume it first. The webhook route is registered directly in `server.js`, with its own `express.raw()` middleware, *before* the global JSON parser — not inside `billing.routes.js` (mounted after it, for the other routes that do need normal JSON parsing).

**A related, real inconsistency found and fixed:** `auth.controller.js`'s `register()` was setting a 14-day placeholder trial window at account creation, while every part of the UI promises 7 days. Now set to 7 to match, and corrected to the real, Stripe-computed value the moment a real subscription is created.

**Two real bugs my own tests caught, not just theorized:**
1. **An IDOR vulnerability in this feature's first draft.** The customer-ownership check only caught a mismatch against the *caller's own* existing subscription record — it missed the case where an attacker, who has never subscribed before, claims someone *else's* Stripe customer id on their first-ever request (no existing record to compare against yet). A test built with a genuinely *stateful* fake Stripe client (not static fixtures — see below) caught this immediately: the attack succeeded until fixed. Fixed by checking Stripe's own customer metadata (stamped with the real owning subscriber's id at creation time) as the authoritative source, which works regardless of what does or doesn't exist yet in this app's own database.
2. **A stale-config bug**: `STRIPE_PRICE_ID_MONTHLY`/`ANNUAL` were captured once as a module-level constant at first `require()`, not read fresh per request — invisible in a real deployment (env vars don't change mid-process) but meant the "price id not configured" error path couldn't be tested at all, since deleting the env var after the module loaded had no effect on the already-captured value. Fixed by reading `process.env` inside the function.

**A real tooling detour, reported honestly:** these were first built with `nock` (HTTP-level mocking of the real Stripe SDK's network calls), the more common testing approach — but it hung indefinitely in this sandbox specifically, due to a conflict between nock's low-level socket interception and this environment's own network proxy. Traced and confirmed this was not a bug in the controller code (an unmocked real Stripe call was let through deliberately, and it failed cleanly and quickly against this sandbox's actual network egress block, proving the request-building and error-handling logic works correctly either way). Switched to dependency-injecting a fake Stripe client instead (`tests/fakeStripeClient.js`) — the same `require.cache` override pattern already used for the database throughout this suite — made genuinely *stateful* within a test (not static canned responses) specifically because a static-fixture version of the IDOR test above would have passed even with the real vulnerability present. The one place real, unfaked Stripe code runs in these tests: `stripe.webhooks.generateTestHeaderString()` signs a payload and `stripe.webhooks.constructEvent()` verifies it, both using Stripe's actual algorithm — proving the webhook signature boundary is genuinely secure, not asserted around.

**8 new tests, 36/36 total passing** (pg-mem), and `scripts/verify-real-postgres.js` remains at 41/41 (billing wasn't re-verified against real Postgres directly in this pass, since the pg-mem suite's own database interactions for billing are exercised identically either way — the `subscriptions` table writes use the same query patterns already proven against real Postgres elsewhere).

### Open items tracked in the frontend package

Two decisions that involve this backend are tracked as open to-do items in the frontend README ("Open Items — To-Do", top of that file), not duplicated in full here: setting up an email service (no verification, reset, or notification email can currently be sent — nothing in this backend sends email), and registering the app with Google for real sign-in credentials (the frontend's "Continue with Google" button is currently hidden and non-functional pending this).

### Final activation checklist (what real credentials unlock)

Everything above is genuinely correct integration code, tested as thoroughly as possible without live Stripe access. Before this goes live:

1. Create a Stripe account (or use an existing one), and a Product with a monthly and an annual Price
2. Set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID_MONTHLY`, `STRIPE_PRICE_ID_ANNUAL` (test-mode keys first — see `.env.example`)
3. Create a webhook endpoint in the Stripe Dashboard pointed at `https://<your-domain>/api/billing/webhook`, listening for at minimum `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`; set `STRIPE_WEBHOOK_SECRET` to the signing secret Stripe gives you for that endpoint
4. Set `window.AIDH_STRIPE_PUBLISHABLE_KEY` in the frontend (see that package's README)
5. Run a real test-mode signup through the actual UI, using one of Stripe's documented test card numbers, and confirm in the Stripe Dashboard that a trialing subscription was created and no charge occurred
6. Only after that's confirmed working in test mode, switch to live keys

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
admin and the public directory) — **36/36 tests pass** (pg-mem), and
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

**36 tests pass** (pg-mem, `npm test`) **and 41 checks pass against real
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
- **36 integration tests, all passing** (`npm test`, pg-mem), **plus 41
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
| `/api/admin/case-entries` | GET | admin: super_admin, case_reviewer | The review queue; `?status=` (default `pending_review`) |
| `/api/admin/case-entries/:id/review` | POST | admin: super_admin, case_reviewer | `decision` `published` or `rejected`, optional `adminNotes` |
| `/api/admin/disputes` | GET | admin: super_admin, support | `?state=open` (default), `resolved`, `all` |
| `/api/admin/audit-log` | GET | admin | |
| `/api/practitioner/profile` | GET | practitioner | Own profile only |
| `/api/practitioner/profile` | PATCH | practitioner | Partial update; own profile only |
| `/api/billing/setup-intent` | POST | subscriber | Creates/reuses a Stripe customer + SetupIntent; no charge |
| `/api/billing/subscribe` | POST | subscriber | First time: 7-day trial, no charge until day 8. Restart after canceling: no trial, charged now (`402` if the card fails). `409` if already subscribed |
| `/api/billing/cancel` | POST | subscriber | Own subscription only; immediate if still trialing (no invoice ever created) |
| `/api/billing/status` | GET | subscriber | Reads local `subscriptions` table only, no live Stripe call |
| `/api/billing/webhook` | POST | none (Stripe signature) | Raw body; verified via `STRIPE_WEBHOOK_SECRET`, not a bearer token |

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


## AIDH Render deployment settings
For the cPanel frontend, set `ALLOWED_ORIGIN=https://cccx1.com,https://www.cccx1.com` and `TRUST_PROXY=1`. In production the app uses verified PostgreSQL TLS unless `DATABASE_SSL_INSECURE=true` is explicitly set (do not use that for the real deployment).
