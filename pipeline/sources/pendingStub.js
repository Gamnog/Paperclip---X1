// Shared stub for Tier B/C sources cleared in FIR-16 but not yet wired to a
// verified live feed/API (FIR-23 M4). Each registry entry using this module
// supplies `config.notes` (why it's not live) and `config.action` (what
// unblocks it) so `node run.js` prints a clear next step instead of silently
// doing nothing or — worse — guessing at an unverified URL.
//
// Rationale for stubbing instead of guessing: this pipeline feeds a legal
// digest, so a fetcher pointed at a wrong/unverified URL could silently
// return nothing (undetected gap) or wrong content. Safer to stub with a
// documented next step than fabricate an endpoint.

async function fetchItems({ sourceId, sourceName, notes, action }) {
  console.warn(`[${sourceId}] NOT YET LIVE — ${sourceName}`);
  if (notes) console.warn(`[${sourceId}]   ${notes}`);
  if (action) console.warn(`[${sourceId}]   Next step: ${action}`);
  return [];
}

module.exports = { fetchItems };
