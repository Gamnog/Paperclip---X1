// ISIR SOAP WS source — FIR-16 §3 MANDATORY: corporate-entity proceedings only.
// Individual (natural-person) debtor records MUST NOT be ingested, summarized, or
// delivered — this is a hard GDPR compliance requirement, not optional.
//
// STATUS: pending_registration
// The SOAP WS endpoint URL is not publicly documented. The WSDL distributed at
// https://isir.justice.cz/isir/help/IsirWsPublic.zip has a localhost placeholder
// for the service address. Contact technickapodpora.isir@msp.justice.cz with:
//   - Project description (pilot legal-monitoring digest, non-commercial)
//   - Intended usage scope (corporate reorganization proceedings only)
//   - Requested endpoint URL for IsirWsPublicService
//
// Once the endpoint URL is obtained, implement:
// 1. Call getIsirWsPublicPodnetPosledniId to get the latest event ID.
// 2. Iterate from (lastSeenId + 1) to latest, batching with getIsirWsPublicPodnetId.
// 3. Filter: keep only events where the case file (spisovaZnacka) belongs to a
//    corporate entity (PO / právnická osoba). The XSD field "oddil" or a separate
//    ISIR2 call can identify entity type — see IsirWsPublicTypes.xsd.
// 4. Apply the FIR-13 relevance filter: reorganization, odpůrčí, creditor proceedings.
//
// Alternative path: use Hlídač státu API (source #20) which wraps ISIR with REST
// and links to ARES — requires API key registration at hlidacstatu.cz/api/v2.

async function fetchItems({ sourceId, sourceName }) {
  console.warn(`[${sourceId}] PENDING REGISTRATION — ISIR SOAP WS endpoint URL not yet obtained.`);
  console.warn(`[${sourceId}] Contact: technickapodpora.isir@msp.justice.cz`);
  console.warn(`[${sourceId}] Alternative: Hlídač státu API (hlidacstatu.cz/api/v2) with registration.`);
  return [];
}

module.exports = { fetchItems };
