// src/lib/mailer.js
//
// One place that sends email, so the booking code never knows which provider is behind it.
// MAIL_PROVIDER: 'resend' (production: needs RESEND_API_KEY and MAIL_FROM, a sender on a domain verified
// in Resend), 'console' (development: prints), 'outbox' (tests: keeps messages in memory). Anything else
// logs a clear warning and sends nothing.
//
// A failed or skipped email must never undo a payment or a booking, so sendMail never throws: it returns
// { ok: false, reason }. The confirmation page shows the video link itself, so a missed email is not a
// missed session. Message bodies carry booking details only, never health data. Recipient addresses and
// bodies are never written to the log.
const outbox = [];

async function sendViaResend({ to, subject, text }) {
  const key = process.env.RESEND_API_KEY, from = process.env.MAIL_FROM;
  if (!key || !from) { console.warn('[mail] MAIL_PROVIDER=resend but RESEND_API_KEY or MAIL_FROM is missing -- email NOT sent'); return { ok: false, reason: 'resend_not_configured' }; }
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: ctl.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[mail] Resend rejected a message (HTTP ${res.status}): ${body.slice(0, 200)}`);
      return { ok: false, reason: `resend_${res.status}` };
    }
    return { ok: true, provider: 'resend' };
  } catch (e) {
    console.error('[mail] Resend request failed:', e && e.message);
    return { ok: false, reason: 'resend_network_error' };
  } finally { clearTimeout(timer); }
}

async function sendMail({ to, subject, text }) {
  const provider = (process.env.MAIL_PROVIDER || (process.env.NODE_ENV === 'production' ? '' : 'console')).toLowerCase();
  if (provider === 'resend') return sendViaResend({ to, subject, text });
  if (provider === 'outbox') { outbox.push({ to, subject, text }); return { ok: true, provider }; }
  if (provider === 'console') {
    if (process.env.NODE_ENV !== 'production') console.log(`[mail:console] to=${to} subject=${subject}\n${text}\n`);
    return { ok: true, provider };
  }
  console.warn(`[mail] MAIL_PROVIDER is not configured ("${provider || 'unset'}") -- email NOT sent: ${subject}`);
  return { ok: false, reason: 'not_configured' };
}

module.exports = { sendMail, outbox };
