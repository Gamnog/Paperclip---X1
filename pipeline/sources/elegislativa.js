// e-Legislativa REST API source — draft legislation in the legislative pipeline.
//
// STATUS: pending_registration
// Same MV API registration process as e-Sbírka (api.e-legislativa.gov.cz).
// Submit application via data message to Ministry of Interior.
//
// Once registered, implement:
//   GET https://api.e-legislativa.gov.cz/podnety?keyword=insolven&stavRizeni=...
// Monitor for any amendment to zákon č. 182/2006 (IZ) or new restructuring acts
// at the government proposal / parliamentary bill stage.

async function fetchItems({ sourceId, sourceName }) {
  console.warn(`[${sourceId}] PENDING REGISTRATION — MV API registration required for api.e-legislativa.gov.cz`);
  return [];
}

module.exports = { fetchItems };
