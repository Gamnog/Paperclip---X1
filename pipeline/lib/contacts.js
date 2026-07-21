// Pilot contact registry — stores name, email, firm, and sub-focus for each participant.
// Until FIR-15 pilot contacts are recruited and confirmed, this is empty.
// When contacts are available, add them here as:
//
//   { name, email, firm, subFocus: 'creditor_disputes' | 'distressed_ma' | 'reorganization' | 'all' }
//
// Sub-focus maps to digest filter: items from sources tagged with matching topics are
// included; items outside the contact's sub-focus go to the "also noted" section or
// are omitted (per FIR-13 digest spec: "no per-recipient AI re-summarization variance
// in v1 — same core summary shown to all, only selection/ordering is personalized").
//
// Per FIR-16 §6 (GDPR): store only name, email, firm, sub-focus — the minimum needed
// for delivery and personalization. Honor deletion requests (remove entry here).
//
// Notification to contacts at onboarding: one line in the outreach message confirming
// name/email/sub-focus are stored for digest delivery only (per FIR-15 outreach draft).

const CONTACTS = [
  // Add confirmed pilot contacts here once FIR-15 is complete.
  // Example:
  // { name: 'Jan Novák', email: 'novak@law-firm.cz', firm: 'Novák & partneři', subFocus: 'creditor_disputes' },
];

module.exports = { CONTACTS };
