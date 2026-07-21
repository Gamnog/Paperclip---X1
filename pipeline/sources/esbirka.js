// e-Sbírka REST API source — legislative amendments (zákon č. 182/2006 Sb., IZ and related).
//
// STATUS: pending_registration
// Requires one-time Ministry of Interior (MV) API registration via data message.
// Register at https://api.e-sbirka.gov.cz — submit application via data message to MV.
// Until registered, this source is unavailable.
//
// Once registered with an API key, implement:
//   GET https://api.e-sbirka.gov.cz/pravni-predpisy?stavPlatnosti=PLATNY&offset=0&pocet=20
// filter for acts referencing "182/2006" (IZ) or "294/2013" (amendment) or "31/2019" (restructuring)
// and any new promulgation in the Sbírka zákonů that touches insolvency law.

async function fetchItems({ sourceId, sourceName }) {
  console.warn(`[${sourceId}] PENDING REGISTRATION — MV API registration required for api.e-sbirka.gov.cz`);
  return [];
}

module.exports = { fetchItems };
