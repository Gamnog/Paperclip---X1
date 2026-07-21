// Source registry for the Firezard pilot pipeline (FIR-17).
// Each entry has: id, name, module (path), tier, notes.
// "module" must export: { fetchItems(options) -> Promise<Item[]> }
// Item shape: { id, title, url, pubDate, summary, sourceId, sourceName, relevanceTags }

const path = require('path');
const r = (m) => path.join(__dirname, m);

const SOURCES = [
  {
    id: 'ns-sbirka',
    name: 'NS Sbírka — senate 29 (insolvency)',
    tier: 'A',
    module: r('../run.js'),      // M1 module — fetched separately in run.js orchestrator
    status: 'active',
  },
  {
    id: 'us-nalus',
    name: 'ÚS NALUS — weekly decision summaries',
    tier: 'A',
    module: r('./rss-generic.js'),
    config: {
      feedUrl: 'https://www.usoud.cz/rss',
      keywords: ['insolven', 'reorganizac', 'přihláš', 'věřitel', 'konkurs', 'oddlužen', 'restrukturalizac'],
      encoding: 'utf-8',
    },
    status: 'active',
  },
  {
    id: 'insolvence-justice',
    name: 'insolvence.justice.cz — Ministry methodologies',
    tier: 'A',
    module: r('./rss-generic.js'),
    config: {
      feedUrl: 'https://insolvence.justice.cz/feed/',
      keywords: [],  // all items are insolvency-domain by definition — no keyword filter
      encoding: 'utf-8',
    },
    status: 'active',
  },
  {
    id: 'psp-rss',
    name: 'PSP — new parliamentary bills',
    tier: 'A',
    module: r('./rss-generic.js'),
    config: {
      feedUrl: 'https://www.psp.cz/rss/tisky.rss',
      keywords: ['insolven', 'reorganizac', 'restrukturalizac', 'konkurs', 'oddlužen', 'věřitel'],
      encoding: 'windows-1250',
      maxAgeDays: 30,  // PSP also archives - filter to recent 30 days
    },
    status: 'active',
  },
  {
    id: 'senat-rss',
    name: 'Senát — recently debated bills',
    tier: 'A',
    module: r('./rss-generic.js'),
    config: {
      feedUrl: 'https://www.senat.cz/dokumenty/posledni_projednavane_tisky_rss.php',
      keywords: ['insolven', 'reorganizac', 'restrukturalizac', 'konkurs'],
      encoding: 'utf-8',
      maxAgeDays: 30,  // 5200-item archive - must restrict by date
    },
    status: 'active',
  },
  {
    id: 'asis-feed',
    name: 'ASIS — insolvency administrators association news',
    tier: 'A',
    module: r('./rss-generic.js'),
    config: {
      feedUrl: 'https://www.asis.cz/feed/',
      keywords: [],   // all ASIS content is domain-relevant
      encoding: 'utf-8',
    },
    status: 'active',
  },
  {
    id: 'cnb-rss',
    name: 'ČNB — regulatory press releases',
    tier: 'B',
    module: r('./rss-generic.js'),
    config: {
      feedUrl: 'https://www.cnb.cz/cs/.content/rss-feed/rss-feed_tz.rss',
      keywords: ['insolven', 'reorganizac', 'restrukturalizac', 'likvidac', 'nucen', 'správce'],
      encoding: 'utf-8',
    },
    status: 'active',
  },
  {
    id: 'epravo-rss',
    name: 'epravo.cz — legal news (free content only)',
    tier: 'B',
    module: r('./rss-generic.js'),
    config: {
      feedUrl: 'https://www.epravo.cz/rss.php',
      keywords: ['insolven', 'reorganizac', 'restrukturalizac', 'konkurs', 'oddlužen', 'věřitel', 'úpadek', 'odpůrčí'],
      encoding: 'utf-8',
    },
    status: 'active',
    notes: 'Verified live 2026-07-21 (valid RSS 2.0, public articles). FIR-16 restricts epravo.cz to free content only — this feed surfaces the site’s public article teasers, consistent with that scope; re-check if epravo changes the feed to include paywalled content.',
  },
  {
    id: 'profipravo-rss',
    name: 'profipravo.cz — case law digest, obchodněprávní shrnutí (free content only)',
    tier: 'B',
    module: r('./rss-generic.js'),
    config: {
      feedUrl: 'https://www.profipravo.cz/rss/obchodnepravni-shrnuti.php',
      keywords: ['insolven', 'reorganizac', 'restrukturalizac', 'konkurs', 'oddlužen', 'věřitel', 'úpadek', 'odpůrčí'],
      encoding: 'utf-8',
    },
    status: 'active',
    notes: 'Resolved 2026-07-21: the footer "RSS" link led to a links page listing per-category feeds; "Obchodněprávní shrnutí" (commercial-law case summaries) is the closest fit for insolvency/restructuring case law. Verified live via curl (valid RSS 0.91, current items). Other profipravo category feeds exist (procesni-shrnuti.php, monitoring.php, clanky-a-komentare.php, zpravodajstvi.php) if broader coverage is wanted later. FIR-16 free-content-only restriction applies — this is the public feed, not paywalled content.',
  },
  {
    id: 'nss-rss',
    name: 'NSS — Nejvyšší správní soud (administrative supreme court)',
    tier: 'B',
    module: r('./pendingStub.js'),
    config: {
      notes: 'Re-confirmed 2026-07-21: nssoud.cz/rss and /feed both redirect to www.nssoud.cz equivalents which 404; sbirka.nssoud.cz/rss also 404s; no RSS link found on the tiskové zprávy (press releases) page or in page source. This is not a bot-block — the site genuinely appears to have no RSS feed. NSS decisions can matter for insolvency-adjacent administrative disputes (e.g. tax claims in proceedings).',
      action: 'CEO-assigned per FIR-23 interaction: confirm in a browser whether NSS offers any feed/export (check judikatura search UI at vyhledavac.nssoud.cz for an export/subscribe option) or decide to drop this source. Tracked together with zakonyprolidi.cz in the follow-up ticket.',
    },
    status: 'pending_registration',
  },
  {
    id: 'zakonyprolidi-rss',
    name: 'zakonyprolidi.cz — newly promulgated legislation',
    tier: 'B',
    module: r('./pendingStub.js'),
    config: {
      notes: 'zakonyprolidi.cz/rss confirms an RSS channels page exists, but it 403’d on automated fetch (likely bot-blocking) — could not confirm the exact channel URL for "nové vyhlášené předpisy".',
      action: 'Open zakonyprolidi.cz/rss in a browser, copy the exact channel URL for newly-promulgated regulations, and confirm it still resolves from the deployment host before wiring (module: rss-generic.js).',
    },
    status: 'pending_registration',
  },
  {
    id: 'eurlex-rss',
    name: 'EUR-Lex — EU insolvency regulation & case law (Reg. 2015/848 etc.)',
    tier: 'C',
    module: r('./pendingStub.js'),
    config: {
      notes: 'EUR-Lex does not publish a static public RSS for search results — "My RSS alerts" is an account feature: you save a search while logged in and EUR-Lex gives you a per-account feed URL.',
      action: 'CEO decision 2026-07-21 (FIR-23 interaction): skipped for the pilot — not worth the account-registration setup time right now. Revisit post-pilot if EU-level insolvency case law becomes a gap contacts flag.',
    },
    status: 'pending_registration',
  },
  {
    id: 'hlidac-statu-insolvence',
    name: 'Hlídač státu — insolvenční rejstřík API (wraps ISIR + ARES)',
    tier: 'C',
    module: r('./pendingStub.js'),
    config: {
      notes: 'REST API at api.hlidacstatu.cz (swagger: api.hlidacstatu.cz/swagger/index.html) requires an auth token. Also a viable alternative path to ISIR corporate-proceedings data (see sources/isir-soap.js) if the direct SOAP endpoint stays unobtainable.',
      action: 'CEO decision 2026-07-21 (FIR-23 interaction): skipped for the pilot — not worth the account-registration setup time right now. Revisit post-pilot, or if ISIR SOAP access (see isir-soap.js) never resolves and this stays the best path to insolvenční rejstřík data.',
    },
    status: 'pending_registration',
  },
  {
    id: 'advokatni-denik-rss',
    name: 'Advokátní deník — Czech Bar Association news (successor to cak.cz feed)',
    tier: 'C',
    module: r('./rss-generic.js'),
    config: {
      feedUrl: 'https://advokatnidenik.cz/feed/',
      keywords: ['insolven', 'reorganizac', 'restrukturalizac', 'konkurs', 'oddlužen', 'věřitel', 'úpadek', 'odpůrčí'],
      encoding: 'utf-8',
    },
    status: 'active',
    notes: 'Verified live 2026-07-21 (valid WordPress RSS 2.0 feed, "Novinky ze světa advokacie"). No RSS feed exists on cak.cz itself — this is where Bar Association-adjacent legal news/opinion actually lives now (FIR-23).',
  },
  {
    id: 'msp-gov-rss',
    name: 'msp.gov.cz — Ministry of Justice (general, distinct from insolvence.justice.cz)',
    tier: 'C',
    module: r('./pendingStub.js'),
    config: {
      notes: 'No RSS feed found on msp.gov.cz. Ministry methodology content specific to insolvency is already covered by the active insolvence.justice.cz source — this would only add general ministry press releases.',
      action: 'Low priority: confirm via msp.gov.cz press office (press@msp.gov.cz) whether a press-release RSS/API exists before spending more time on this one.',
    },
    status: 'pending_registration',
  },
  {
    id: 'isir-soap',
    name: 'ISIR — corporate insolvency proceedings (SOAP WS)',
    tier: 'A',
    module: r('./isir-soap.js'),
    config: {},
    status: 'pending_registration',
    notes: 'SOAP WS endpoint URL not publicly documented — WSDL has localhost placeholder. Contact technickapodpora.isir@msp.justice.cz to get the production endpoint URL. See FIR-16 §3: MANDATORY corporate-only filter at ingestion.',
  },
  {
    id: 'esbirka-api',
    name: 'e-Sbírka — legislation amendments (REST API)',
    tier: 'A',
    module: r('./esbirka.js'),
    config: {},
    status: 'pending_registration',
    notes: 'Requires one-time Ministry of Interior API registration via data message to api.e-sbirka.gov.cz. See FIR-14 catalog action item.',
  },
  {
    id: 'elegislativa-api',
    name: 'e-Legislativa — draft legislation (REST API)',
    tier: 'A',
    module: r('./elegislativa.js'),
    config: {},
    status: 'pending_registration',
    notes: 'Same MV registration as e-Sbírka (same API registration process). See FIR-14 catalog action item.',
  },
];

module.exports = { SOURCES };
