// src/lib/consultationEmails.js -- plain-text booking emails. Booking details only.
function fmt(ms, tz) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(new Date(ms)) + ` (${tz})`;
  } catch (e) { return new Date(ms).toISOString(); }
}
const utc = (ms) => new Date(ms).toISOString().replace('T', ' ').replace(/:\d\d\.\d+Z$/, ' UTC');
const money = (c, cur) => `${(c / 100).toFixed(2)} ${String(cur).toUpperCase()}`;
const FOOT = '\nThis consultation is educational support. It works alongside, never instead of, your own physician.\n';

function confirmedForSubscriber(c) {
  return {
    subject: `Your consultation is confirmed (ref ${c.ref})`,
    text: `Your consultation is confirmed.\n\nReference: ${c.ref}\nWith: ${c.practitionerName || ('practitioner ' + c.practitionerCode)}\nWhen: ${utc(c.startsAtMs)}  (${fmt(c.startsAtMs, c.timezone)} in the practitioner's time zone)\nPaid: ${money(c.amountCents, c.currency)}\n\nJoin by video: ${c.videoLink}\n\nThe practitioner admits each person individually, so please join with the name or email you booked with and be patient for a moment after you ask to join.\n\nCancellations made more than ${c.freeCancelHours} hours before the start receive ${c.deductsFee ? 'a refund of the consultation fee paid, less the third-party payment processing fee incurred (the processor keeps that fee and does not return it)' : 'a full refund'}. After that the booking is not refundable.\nIf the session does not take place or something went wrong, report it from your bookings within 24 hours after it ends.\n${FOOT}`,
  };
}
function confirmedForPractitioner(c) {
  return {
    subject: `New booking (ref ${c.ref})`,
    text: `You have a new booking.\n\nReference: ${c.ref}\nWhen: ${fmt(c.startsAtMs, c.timezone)}  [${utc(c.startsAtMs)}]\nSession price: ${money(c.amountCents, c.currency)} (your share is released about ${c.releaseDelayHours} hours after the session, minus the payment processor's fee)\n${c.subscriberEmail ? `Booked by: ${c.subscriberEmail}\n` : ''}\nUse your usual video room: ${c.videoLink}\nAdmit only the person you are expecting for this booking.\n${FOOT}`,
  };
}
function cancelled(c) {
  let refund;
  if (c.refundCents > 0 && c.withheldCents > 0) refund = `A refund of ${money(c.refundCents, c.currency)} has been issued to the original payment method. That is the consultation fee paid (${money(c.amountCents, c.currency)}) less the third-party payment processing fee incurred (${money(c.withheldCents, c.currency)}).`;
  else if (c.refundCents > 0) refund = `A full refund of ${money(c.refundCents, c.currency)} has been issued to the original payment method.`;
  else refund = 'This cancellation was inside the no-refund period, so no refund was issued.';
  return {
    subject: `Consultation cancelled (ref ${c.ref})`,
    text: `The consultation on ${fmt(c.startsAtMs, c.timezone)} (ref ${c.ref}) was cancelled by the ${c.by}.\n\n${c.forPractitioner ? '' : refund + '\n'}`,
  };
}
module.exports = { confirmedForSubscriber, confirmedForPractitioner, cancelled };
