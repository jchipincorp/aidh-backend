// tests/admin_review_and_disputes.test.js
//
// The admin console's two new screens: the case-entry review queue and the dispute list.
// Real controllers and SQL (in-memory Postgres), fake Stripe. Covers: who may use each screen
// (admin sub-roles), the queue's order and content, every refusal the review endpoint gives,
// the audit trail (and that it never holds case text), the dispute list, and that a dispute can
// only be decided once -- including two admins deciding it at the same moment.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { freshApp, request, register, bookablePractitioner, paidBooking, row, H } = require('./consultation_helpers');

async function adminToken(ctx, adminRole) {
  const id = crypto.randomUUID();
  await ctx.pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'admin')`, [id, `${adminRole}-${id.slice(0, 6)}@test.com`]);
  if (adminRole) await ctx.pool.query(`INSERT INTO admin_users (user_id, admin_role) VALUES ($1, $2)`, [id, adminRole]);
  const authCtrl = require('../src/controllers/auth.controller');
  return authCtrl.issueToken({ id, role: 'admin' });
}

const baseEntry = {
  disciplineSlug: 'reiki', aidhPillar: 'Pillar 3', wellnessCategory: 'General Wellness', organSystemFocus: 'Mental & Emotional',
  engagementDuration: '6 weeks', wellbeingBefore: 4, wellbeingAfter: 7, labCorroboration: 'not_applicable',
  clientConsentConfirmed: true, physicianInvolvementConfirmed: true, outcomeDisclaimerAck: true,
};
async function submit(ctx, prac, over) {
  const r = await request(ctx.app, 'POST', '/api/case-registry', { token: prac.token, body: { ...baseEntry, ...over } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
}
const auditRows = async (ctx, category) => (await ctx.pool.query('SELECT * FROM audit_log WHERE action_category = $1', [category])).rows;

test('admin sub-roles: case review is for super_admin and case_reviewer; disputes for super_admin and support', async () => {
  const ctx = freshApp();
  const sub = await register(ctx, 'subscriber');
  const tokens = {
    noRow: await adminToken(ctx, null),
    super: await adminToken(ctx, 'super_admin'),
    reviewer: await adminToken(ctx, 'case_reviewer'),
    support: await adminToken(ctx, 'support'),
  };
  const get = (url, token) => request(ctx.app, 'GET', url, { token });
  assert.equal((await get('/api/admin/case-entries', sub.token)).status, 403, 'a subscriber');
  const noRow = await get('/api/admin/case-entries', tokens.noRow);
  assert.equal(noRow.status, 403, 'an admin token without an admin_users row');
  assert.equal(noRow.body.code, 'NOT_ADMIN_ACCOUNT');
  assert.equal((await get('/api/admin/case-entries', tokens.super)).status, 200);
  assert.equal((await get('/api/admin/case-entries', tokens.reviewer)).status, 200);
  const sup = await get('/api/admin/case-entries', tokens.support);
  assert.equal(sup.status, 403, 'support cannot review cases');
  assert.equal(sup.body.code, 'ADMIN_ROLE_NOT_ALLOWED');
  assert.deepEqual(sup.body.allowedRoles, ['super_admin', 'case_reviewer']);
  assert.equal((await get('/api/admin/disputes', tokens.super)).status, 200);
  assert.equal((await get('/api/admin/disputes', tokens.support)).status, 200);
  assert.equal((await get('/api/admin/disputes', tokens.reviewer)).status, 403, 'a case reviewer cannot see disputes');
  assert.equal((await get('/api/admin/disputes', tokens.noRow)).status, 403);
  const fakeId = crypto.randomUUID();
  const resolveAs = (token) => request(ctx.app, 'POST', `/api/consultations/admin/${fakeId}/resolve`, { token, body: { action: 'refund' } });
  assert.equal((await resolveAs(tokens.reviewer)).status, 403, 'a case reviewer cannot decide a dispute');
  assert.equal((await resolveAs(tokens.noRow)).status, 403, 'an admin token without an admin_users row cannot decide a dispute');
  assert.equal((await resolveAs(tokens.support)).status, 409, 'support passes the role check (and the booking does not exist)');
  const reviewAs = (token) => request(ctx.app, 'POST', `/api/admin/case-entries/${fakeId}/review`, { token, body: { decision: 'rejected' } });
  assert.equal((await reviewAs(tokens.support)).status, 403);
  assert.equal((await reviewAs(tokens.reviewer)).status, 404);
});

test('case queue: pending entries, priority first then oldest first, with the case text readable and missing consents named', async () => {
  const ctx = freshApp();
  const prac = await register(ctx, 'practitioner');
  const plain = await submit(ctx, prac, { subscriberCaseCode: 'CASE-A', changeSummary: 'Entry A text.' });
  const priority = await submit(ctx, prac, { subscriberCaseCode: 'CASE-B', changeSummary: 'Entry B text.', wellnessCategory: 'Oncology-Adjacent Supportive Care' });
  const noPhysician = await submit(ctx, prac, { subscriberCaseCode: 'CASE-C', changeSummary: 'Entry C text.', physicianInvolvementConfirmed: false });
  await ctx.pool.query(`UPDATE case_entries SET submitted_at = $2 WHERE id = $1`, [plain, new Date(Date.now() - 3 * H)]);
  await ctx.pool.query(`UPDATE case_entries SET submitted_at = $2 WHERE id = $1`, [priority, new Date(Date.now() - 1 * H)]);
  await ctx.pool.query(`UPDATE case_entries SET submitted_at = $2 WHERE id = $1`, [noPhysician, new Date(Date.now() - 2 * H)]);
  const token = await adminToken(ctx, 'case_reviewer');

  const q = await request(ctx.app, 'GET', '/api/admin/case-entries', { token });
  assert.equal(q.status, 200);
  assert.equal(q.body.status, 'pending_review', 'the default is the pending queue');
  assert.deepEqual(q.body.entries.map((e) => e.subscriber_case_code), ['CASE-B', 'CASE-A', 'CASE-C'], 'priority first, then oldest first');
  const a = q.body.entries.find((e) => e.id === plain);
  assert.equal(a.change_summary, 'Entry A text.', 'the reviewer reads the decrypted text');
  assert.equal(a.decrypt_failed, false);
  assert.equal(a.discipline, 'Reiki');
  assert.match(a.practitioner_display_name, /^PRACT-\d+$/, 'falls back to the practitioner code before the profile has a name');
  assert.deepEqual(a.missing_consents, []);
  assert.deepEqual(q.body.entries.find((e) => e.id === noPhysician).missing_consents, ['physician involvement']);
  assert.equal(q.body.entries.find((e) => e.id === priority).priority_review, true);

  assert.equal((await request(ctx.app, 'GET', '/api/admin/case-entries?status=nonsense', { token })).status, 400);
  assert.equal((await request(ctx.app, 'GET', '/api/admin/case-entries?status=published', { token })).body.count, 0);
  assert.equal((await request(ctx.app, 'GET', '/api/admin/case-entries?status=all', { token })).body.count, 3);
});

test('case review: refusals (404, 400, 409) leave the entry untouched; publish, take down and reconsider are audited without case text', async () => {
  const ctx = freshApp();
  const prac = await register(ctx, 'practitioner');
  const good = await submit(ctx, prac, { subscriberCaseCode: 'CASE-GOOD', changeSummary: 'A distinctive sentence about sleep.' });
  const noConsent = await submit(ctx, prac, { subscriberCaseCode: 'CASE-NOCONSENT', changeSummary: 'Other text.', clientConsentConfirmed: false, outcomeDisclaimerAck: false });
  const token = await adminToken(ctx, 'case_reviewer');
  const review = (id, body) => request(ctx.app, 'POST', `/api/admin/case-entries/${id}/review`, { token, body });
  const statusOf = async (id) => (await ctx.pool.query('SELECT status FROM case_entries WHERE id = $1', [id])).rows[0].status;

  assert.equal((await review('not-a-uuid', { decision: 'published' })).status, 404, 'a malformed id');
  assert.equal((await review(crypto.randomUUID(), { decision: 'published' })).status, 404, 'an id that does not exist (used to answer 200 with an empty body)');
  assert.equal((await review(good, { decision: 'maybe' })).status, 400);
  assert.equal((await review(good, { decision: 'rejected', adminNotes: 'x'.repeat(2001) })).status, 400, 'notes are capped');
  assert.equal((await review(good, { decision: 'rejected', adminNotes: { not: 'text' } })).status, 400);

  const blocked = await review(noConsent, { decision: 'published' });
  assert.equal(blocked.status, 409, 'missing consents are a clear refusal, not a database error');
  assert.deepEqual(blocked.body.missingConsents, ['client consent', 'outcome disclaimer']);
  assert.equal(await statusOf(noConsent), 'pending_review');

  const pub = await review(good, { decision: 'published', adminNotes: '  Checked wording.  ' });
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  assert.equal(pub.body.status, 'published'); assert.equal(pub.body.previousStatus, 'pending_review');
  const stored = (await ctx.pool.query('SELECT admin_notes, reviewed_by, reviewed_at FROM case_entries WHERE id = $1', [good])).rows[0];
  assert.equal(stored.admin_notes, 'Checked wording.', 'notes are trimmed');
  const adminRow = (await ctx.pool.query(`SELECT au.id FROM admin_users au WHERE au.admin_role = 'case_reviewer'`)).rows[0];
  assert.equal(stored.reviewed_by, adminRow.id, 'reviewed_by is the admin_users id of the reviewer');
  assert.ok(stored.reviewed_at);
  const publicList = await request(ctx.app, 'GET', '/api/case-registry');
  assert.ok(publicList.body.entries.some((e) => e.id === good), 'a published entry is on the public directory');

  assert.equal((await review(good, { decision: 'published' })).status, 409, 'already published');

  assert.equal((await review(good, { decision: 'rejected' })).status, 200, 'a published entry can be taken down');
  assert.equal(await statusOf(good), 'rejected');
  assert.ok(!(await request(ctx.app, 'GET', '/api/case-registry')).body.entries.some((e) => e.id === good), 'and it leaves the public directory');
  assert.equal((await review(good, { decision: 'published' })).status, 200, 'a rejected entry can be reconsidered');

  const audit = await auditRows(ctx, 'CASE_ENTRY');
  assert.deepEqual(audit.map((a) => a.action).sort(), ['PUBLISHED', 'PUBLISHED', 'UNPUBLISHED'], 'only the three real changes are audited, not the refusals');
  for (const a of audit) {
    assert.equal(a.actor_type, 'admin');
    assert.ok(!/sleep|distinctive|CASE-GOOD/i.test(a.description), 'the audit log never holds case text or the case code: ' + a.description);
  }
});

test('case review: someone else changing the entry between read and write is refused, not overwritten', async () => {
  const ctx = freshApp();
  const prac = await register(ctx, 'practitioner');
  const id = await submit(ctx, prac, { subscriberCaseCode: 'CASE-RACE', changeSummary: 'Text.' });
  const token = await adminToken(ctx, 'super_admin');
  // Both screens showed the entry waiting, so both send expectedStatus 'pending_review' (as the console does). Without
  // it, two requests that happen not to overlap are a legitimate publish-then-take-down, so the outcome would depend
  // on timing (this test was flaky that way in 0.6.0).
  const [r1, r2] = await Promise.all([
    request(ctx.app, 'POST', `/api/admin/case-entries/${id}/review`, { token, body: { decision: 'published', expectedStatus: 'pending_review' } }),
    request(ctx.app, 'POST', `/api/admin/case-entries/${id}/review`, { token, body: { decision: 'rejected', expectedStatus: 'pending_review' } }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409], 'exactly one decision wins: ' + JSON.stringify([r1.body, r2.body]));
  assert.equal((await auditRows(ctx, 'CASE_ENTRY')).length, 1);
});

test('case queue: an entry whose text cannot be decrypted is listed and flagged, not hidden and not a 500', async () => {
  const ctx = freshApp();
  const prac = await register(ctx, 'practitioner');
  const ok = await submit(ctx, prac, { subscriberCaseCode: 'CASE-OK', changeSummary: 'Readable.' });
  const bad = await submit(ctx, prac, { subscriberCaseCode: 'CASE-BAD', changeSummary: 'Will be corrupted.' });
  // Text encrypted under a different key: what a key rotation that missed this row would leave behind.
  const { encryptField } = require('../src/lib/fieldEncryption');
  await ctx.pool.query(`UPDATE case_entries SET change_summary = $2 WHERE id = $1`, [bad, encryptField('Will be corrupted.', crypto.randomBytes(32).toString('hex'))]);
  const token = await adminToken(ctx, 'case_reviewer');
  const q = await request(ctx.app, 'GET', '/api/admin/case-entries', { token });
  assert.equal(q.status, 200);
  assert.equal(q.body.entries.find((e) => e.id === ok).change_summary, 'Readable.');
  const flagged = q.body.entries.find((e) => e.id === bad);
  assert.ok(flagged, 'the unreadable entry is still in the queue');
  assert.equal(flagged.decrypt_failed, true); assert.equal(flagged.change_summary, null);
});

async function twoDisputes(ctx) {
  const prac = await bookablePractitioner(ctx);
  const s1 = await register(ctx, 'subscriber'); const s2 = await register(ctx, 'subscriber');
  const b1 = await paidBooking(ctx, s1, prac, 0); const b2 = await paidBooking(ctx, s2, prac, 1);
  for (const [id, who, hoursAgo] of [[b1.bookingId, s1, 3], [b2.bookingId, s2, 2]]) {
    await ctx.pool.query('UPDATE consultation_bookings SET starts_at = $1, ends_at = $2, release_after = $3 WHERE id = $4',
      [new Date(Date.now() - hoursAgo * H), new Date(Date.now() - (hoursAgo - 0.5) * H), new Date(Date.now() + 20 * H), id]);
    const r = await request(ctx.app, 'POST', `/api/consultations/${id}/report-issue`, { token: who.token, body: { reason: who === s1 ? 'practitioner_no_show' : 'technical_problem' } });
    assert.equal(r.body.status, 'disputed');
  }
  // Make the report times distinct and in a known order (b1 first).
  await ctx.pool.query('UPDATE consultation_bookings SET issue_reported_at = $2 WHERE id = $1', [b1.bookingId, new Date(Date.now() - 2 * H)]);
  await ctx.pool.query('UPDATE consultation_bookings SET issue_reported_at = $2 WHERE id = $1', [b2.bookingId, new Date(Date.now() - 1 * H)]);
  return { prac, s1, s2, b1: b1.bookingId, b2: b2.bookingId };
}

test('disputes: the open list, refund and release, the resolved list with outcomes, and only the released one is paid', async () => {
  const ctx = freshApp();
  const d = await twoDisputes(ctx);
  const token = await adminToken(ctx, 'support');
  const list = (state) => request(ctx.app, 'GET', `/api/admin/disputes${state ? '?state=' + state : ''}`, { token });

  const open = await list();
  assert.equal(open.status, 200); assert.equal(open.body.state, 'open');
  assert.deepEqual(open.body.disputes.map((x) => x.id), [d.b1, d.b2], 'oldest report first');
  const first = open.body.disputes[0];
  assert.equal(first.ref, d.b1.slice(0, 8).toUpperCase());
  assert.equal(first.amountCents, 4000); assert.equal(first.currency, 'usd');
  assert.equal(first.subscriber.email, d.s1.email); assert.equal(first.practitioner.email, d.prac.email);
  assert.equal(first.practitioner.name, 'Asha Rao'); assert.equal(first.outcome, null);
  assert.equal(Object.keys(first.subscriber).join(','), 'email', 'nothing about the subscriber beyond the contact email');
  assert.equal((await list('nonsense')).status, 400);

  const resolve = (id, action) => request(ctx.app, 'POST', `/api/consultations/admin/${id}/resolve`, { token, body: { action } });
  assert.equal((await resolve(d.b1, 'refund')).status, 200);
  const r1 = await row(ctx, d.b1);
  assert.equal(r1.status, 'cancelled'); assert.equal(r1.refund_cents, 4000);
  assert.ok(r1.issue_resolved_at, 'a refund resolution now records when it was resolved (it used to leave this empty)');
  assert.equal((await resolve(d.b1, 'release')).status, 409, 'a decided dispute cannot be decided again');
  assert.equal((await resolve(d.b2, 'release')).status, 200);

  assert.equal((await list()).body.count, 0, 'nothing left open');
  const resolved = await list('resolved');
  assert.deepEqual(resolved.body.disputes.map((x) => [x.id, x.outcome]), [[d.b2, 'released'], [d.b1, 'refunded']], 'newest first, each with its outcome');
  assert.ok(resolved.body.disputes.every((x) => x.issueResolvedAt));
  assert.equal((await list('all')).body.count, 2);

  const out = await ctx.jobs.runConsultationJobs(Date.now() + 1000);
  assert.equal(out.released, 1, 'only the dispute decided for the practitioner is paid');
  assert.equal((await row(ctx, d.b1)).released_at, null);
  assert.ok((await row(ctx, d.b2)).released_at);
  const audit = (await auditRows(ctx, 'CONSULTATION')).filter((a) => a.action === 'DISPUTE_RESOLVED');
  assert.equal(audit.length, 2);
});

test('disputes: two admins deciding the same dispute at once -- exactly one wins; never refunded AND paid', async () => {
  const ctx = freshApp();
  const d = await twoDisputes(ctx);
  const t1 = await adminToken(ctx, 'super_admin'); const t2 = await adminToken(ctx, 'support');
  const [a, b] = await Promise.all([
    request(ctx.app, 'POST', `/api/consultations/admin/${d.b1}/resolve`, { token: t1, body: { action: 'refund' } }),
    request(ctx.app, 'POST', `/api/consultations/admin/${d.b1}/resolve`, { token: t2, body: { action: 'release' } }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a.body, b.body]));
  await ctx.jobs.runConsultationJobs(Date.now() + 60 * 24 * H);
  const r = await row(ctx, d.b1);
  const refunded = ctx.fake._calls.some((c) => c.resource === 'refunds' && c.args[0].metadata.bookingId === d.b1);
  const paid = ctx.fake._calls.some((c) => c.resource === 'transfers' && c.args[0].transfer_group === d.b1);
  assert.ok(refunded !== paid, `exactly one of refund or payout happened (refunded=${refunded}, paid=${paid}, status=${r.status})`);
});

test('disputes: if the refund call to Stripe fails, the dispute stays open and can be decided again', async () => {
  let failRefund = true;
  const ctx = freshApp({ 'refunds.create': () => { if (failRefund) throw new Error('Stripe is unreachable'); return { id: 're_after_retry' }; } });
  const d = await twoDisputes(ctx);
  const token = await adminToken(ctx, 'super_admin');
  const resolve = () => request(ctx.app, 'POST', `/api/consultations/admin/${d.b1}/resolve`, { token, body: { action: 'refund' } });
  const failed = await resolve();
  assert.equal(failed.status, 500);
  let r = await row(ctx, d.b1);
  assert.equal(r.status, 'disputed'); assert.equal(r.issue_resolved_at, null, 'the claim is undone');
  assert.ok((await request(ctx.app, 'GET', '/api/admin/disputes', { token })).body.disputes.some((x) => x.id === d.b1), 'still on the open list');
  failRefund = false;
  assert.equal((await resolve()).status, 200);
  r = await row(ctx, d.b1);
  assert.equal(r.status, 'cancelled'); assert.ok(r.issue_resolved_at);
});

test('reporting a problem needs one reason from the fixed list; no free text is accepted or stored', async () => {
  const ctx = freshApp();
  const prac = await bookablePractitioner(ctx); const sub = await register(ctx, 'subscriber');
  const b = (await paidBooking(ctx, sub, prac, 0)).bookingId;
  await ctx.pool.query('UPDATE consultation_bookings SET starts_at = $1, ends_at = $2, release_after = $3 WHERE id = $4',
    [new Date(Date.now() - 2 * H), new Date(Date.now() - 1.5 * H), new Date(Date.now() + 22 * H), b]);
  const report = (body) => request(ctx.app, 'POST', `/api/consultations/${b}/report-issue`, { token: sub.token, body });
  const none = await report(undefined);
  assert.equal(none.status, 400); assert.equal(none.body.code, 'REASON_REQUIRED');
  assert.deepEqual(none.body.reasons.map((r) => r.code), ['practitioner_no_show', 'late_or_short', 'technical_problem', 'not_as_booked', 'other'], 'the refusal lists the choices');
  assert.equal((await report({ reason: 'nonsense' })).status, 400);
  assert.equal((await report({ reason: 'My symptoms got worse after the session' })).status, 400, 'free text is refused');
  assert.equal((await report({ reason: 'other', details: 'free text smuggled alongside' })).status, 200, 'a valid code is accepted; any extra field is ignored');
  const r = await row(ctx, b);
  assert.equal(r.status, 'disputed'); assert.equal(r.issue_reason, 'other');
  assert.ok(!JSON.stringify(r).includes('smuggled'), 'nothing but the code is stored');
  const audit = (await ctx.pool.query(`SELECT description FROM audit_log WHERE action = 'ISSUE_REPORTED'`)).rows;
  assert.equal(audit.length, 1); assert.match(audit[0].description, /\(other\)$/);
  assert.equal((await request(ctx.app, 'GET', `/api/consultations/${b}`, { token: sub.token })).body.issueReason, 'other', 'the subscriber sees the reason they gave');
  assert.equal((await request(ctx.app, 'GET', `/api/consultations/${b}`, { token: prac.token })).body.issueReason, undefined, 'the practitioner is not shown it');
});

test('the admin dispute list shows the reason in words; a report from before reasons existed shows none', async () => {
  const ctx = freshApp();
  const d = await twoDisputes(ctx);
  await ctx.pool.query('UPDATE consultation_bookings SET issue_reason = NULL WHERE id = $1', [d.b2]); // as an older report would be
  const token = await adminToken(ctx, 'support');
  const list = (await request(ctx.app, 'GET', '/api/admin/disputes', { token })).body.disputes;
  assert.deepEqual(list.find((x) => x.id === d.b1).reason, { code: 'practitioner_no_show', label: "The practitioner didn't join" });
  assert.equal(list.find((x) => x.id === d.b2).reason, null);
});

test('deciding a dispute emails both people one neutral decision email: never the reason, never the generic cancellation email', async () => {
  const ctx = freshApp();
  const d = await twoDisputes(ctx);
  const token = await adminToken(ctx, 'super_admin');
  ctx.mailer.outbox.length = 0;
  assert.equal((await request(ctx.app, 'POST', `/api/consultations/admin/${d.b1}/resolve`, { token, body: { action: 'refund' } })).status, 200);
  let mails = ctx.mailer.outbox.splice(0);
  assert.equal(mails.length, 2, 'one email to each person, no more: ' + mails.map((m) => m.subject).join(' | '));
  const ref1 = d.b1.slice(0, 8).toUpperCase();
  const toSub = mails.find((m) => m.to === d.s1.email), toPrac = mails.find((m) => m.to === d.prac.email);
  assert.ok(toSub && toPrac, 'both people are told');
  for (const m of mails) {
    assert.equal(m.subject, `Reported problem: decision (ref ${ref1})`);
    assert.ok(!/cancelled by/i.test(m.text), 'not the generic cancellation email');
    assert.ok(!/didn't join|technical|practitioner_no_show/i.test(m.text), 'the reason given is never in the email');
    assert.match(m.text, new RegExp(`quote reference ${ref1}`));
    assert.equal(m.replyTo, undefined, 'no reply-to without SUPPORT_EMAIL');
  }
  assert.match(toSub.text, /We have reviewed the problem you reported/);
  assert.match(toSub.text, /a full refund of 40\.00 USD has been issued/);
  assert.match(toPrac.text, /the subscriber has been refunded in full, so no payout is made/);

  process.env.SUPPORT_EMAIL = 'help@aidh.test';
  try {
    assert.equal((await request(ctx.app, 'POST', `/api/consultations/admin/${d.b2}/resolve`, { token, body: { action: 'release' } })).status, 200);
  } finally { delete process.env.SUPPORT_EMAIL; }
  mails = ctx.mailer.outbox.splice(0);
  assert.equal(mails.length, 2, 'a release now emails both people too (it used to email nobody)');
  const sub2 = mails.find((m) => m.to === d.s2.email), prac2 = mails.find((m) => m.to === d.prac.email);
  assert.match(sub2.text, /the session fee is paid to the practitioner, and no refund is issued/);
  assert.match(prac2.text, /your share \(28\.54 USD after the payment processor's fee\) is released and will be paid with the next payout run/);
  for (const m of mails) {
    assert.equal(m.replyTo, 'help@aidh.test', 'replies go to the support mailbox when one is set');
    assert.match(m.text, /write to help@aidh\.test/);
  }
  assert.equal((await request(ctx.app, 'POST', `/api/consultations/admin/${d.b2}/resolve`, { token, body: { action: 'refund' } })).status, 409);
  assert.equal(ctx.mailer.outbox.length, 0, 'a refused second decision sends nothing');
});

test('case review: a decision made on a screen that is out of date is refused, never applied to a state the reviewer did not see', async () => {
  const ctx = freshApp();
  const prac = await register(ctx, 'practitioner');
  const id = await submit(ctx, prac, { subscriberCaseCode: 'CASE-STALE', changeSummary: 'Text.' });
  const token = await adminToken(ctx, 'case_reviewer');
  const review = (body) => request(ctx.app, 'POST', `/api/admin/case-entries/${id}/review`, { token, body });
  assert.equal((await review({ decision: 'rejected', expectedStatus: 'nonsense' })).status, 400);
  assert.equal((await review({ decision: 'published', expectedStatus: 'pending_review' })).status, 200, 'reviewer A publishes the entry they saw waiting');
  const stale = await review({ decision: 'rejected', expectedStatus: 'pending_review' });
  assert.equal(stale.status, 409, 'reviewer B, whose screen still showed it waiting, clicks Reject: refused, not turned into a take-down');
  assert.equal(stale.body.currentStatus, 'published');
  assert.match(stale.body.error, /changed since you loaded it \(it is now published\)/);
  assert.equal((await ctx.pool.query('SELECT status FROM case_entries WHERE id = $1', [id])).rows[0].status, 'published', 'unchanged');
  assert.equal((await auditRows(ctx, 'CASE_ENTRY')).length, 1, 'only the real decision is audited');
  assert.equal((await review({ decision: 'rejected', expectedStatus: 'published' })).status, 200, 'a take-down made from a screen showing it published works');
});
