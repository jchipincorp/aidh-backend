// src/controllers/booking.controller.js
const db = require('../config/db');

async function createBookingRequest(req, res) {
  const { practitionerMatchId, contactMethod, contactValue, preferredTimeWindow, notes, paymentAgreementAccepted } = req.body;
  if (!paymentAgreementAccepted) {
    return res.status(400).json({ error: 'Payment agreement must be accepted before a booking request can be created' });
  }

  // IDOR fix, same class of bug as consent.controller.js's grantConsent/
  // revokeConsent: this never verified practitionerMatchId belonged to the
  // calling subscriber. Live-exploited before this fix -- an unrelated
  // "attacker" account could create a real booking_request and order
  // against a "victim" subscriber's match, with contact_method/
  // contact_value the attacker controls, effectively hijacking the
  // practitioner's communication channel for that engagement. Confirmed
  // fixed after.
  const owner = await db.query(
    `SELECT pm.id FROM practitioner_matches pm
     JOIN subscriber_profiles sp ON sp.id = pm.subscriber_id
     WHERE pm.id = $1 AND sp.user_id = $2`,
    [practitionerMatchId, req.user.sub]
  );
  if (owner.rows.length === 0) return res.status(404).json({ error: 'No such practitioner match' });

  const result = await db.query(
    `INSERT INTO booking_requests (practitioner_match_id, contact_method, contact_value, preferred_time_window, notes, payment_agreement_accepted_at)
     VALUES ($1, $2, $3, $4, $5, now()) RETURNING id`,
    [practitionerMatchId, contactMethod, contactValue, preferredTimeWindow, notes || null]
  );
  const bookingRequestId = result.rows[0].id;

  const orderRef = 'ORD-' + Date.now().toString(36).toUpperCase();
  const order = await db.query(
    `INSERT INTO orders (booking_request_id, order_reference) VALUES ($1, $2) RETURNING id, order_reference, payment_status`,
    [bookingRequestId, orderRef]
  );

  // TODO production: create the real Stripe/Square PaymentIntent or
  // equivalent here and store only its token reference on the order --
  // never a card number, expiry, or CVV, in this table or anywhere else.
  return res.status(201).json({ bookingRequestId, order: order.rows[0] });
}

module.exports = { createBookingRequest };
