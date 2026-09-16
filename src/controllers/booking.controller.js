// src/controllers/booking.controller.js
const db = require('../config/db');

async function createBookingRequest(req, res) {
  const { practitionerMatchId, contactMethod, contactValue, preferredTimeWindow, notes, paymentAgreementAccepted } = req.body;
  if (!paymentAgreementAccepted) {
    return res.status(400).json({ error: 'Payment agreement must be accepted before a booking request can be created' });
  }

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
