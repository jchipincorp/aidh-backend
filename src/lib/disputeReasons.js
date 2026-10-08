// src/lib/disputeReasons.js -- the fixed list of reasons a subscriber can give when reporting a problem with a
// consultation. One place for the codes and their wording; migration 016 holds the same codes in a CHECK. Codes are
// what is stored, so the wording can change without touching data. No free text, and no outcome-based reason.
const DISPUTE_REASONS = [
  { code: 'practitioner_no_show', label: "The practitioner didn't join" },
  { code: 'late_or_short', label: 'The session started late or ended early' },
  { code: 'technical_problem', label: 'A technical problem (audio, video or connection)' },
  { code: 'not_as_booked', label: "The session wasn't what was booked" },
  { code: 'other', label: "Something else (we'll email you to ask)" },
];
const CODES = DISPUTE_REASONS.map((r) => r.code);
const labelOf = (code) => (DISPUTE_REASONS.find((r) => r.code === code) || {}).label || null;
module.exports = { DISPUTE_REASONS, DISPUTE_REASON_CODES: CODES, disputeReasonLabel: labelOf };
