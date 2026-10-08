// src/controllers/booking.controller.js
//
// RETIRED. The old request-based booking (a subscriber sent a contact detail, a preferred time window and
// free-text notes, and a practitioner was matched by hand) has been replaced by instant bookings
// (/api/consultations). Nothing on the site calls this any more. It now refuses, after the usual sign-in
// checks, so that free-text notes that could hold health details can no longer arrive, and so that the old
// records can be purged for good (see scripts/purge-legacy-booking-requests.js).
//
// History kept for the record: this endpoint once had an IDOR (an unrelated account could create a booking
// request against another subscriber's match). Retiring it closes that vector entirely.
async function createBookingRequest(req, res) {
  return res.status(410).json({
    error: 'Booking requests have been retired. Please book a consultation from the booking page.',
    code: 'BOOKING_REQUESTS_RETIRED',
  });
}

module.exports = { createBookingRequest };
