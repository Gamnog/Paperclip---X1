// Source registry for the Firezard pilot pipeline (FIR-17).
// Each entry has: id, name, module (path), tier, notes.
// "module" must export: { fetchItems(options) -> Promise<Item[]> }
// Item shape: { id, title, url, pubDate, summary, sourceId, sourceName, relevanceTags }

const path = require('path');
const { BROWSER_UA } = require('./rss-generic');
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
    id: 'nss-sbirka',
    name: 'NSS — Sbírka rozhodnutí Nejvyššího správního soudu (curated collection)',
    tier: 'B',
    module: r('./nss-sbirka-scrape.js'),
    config: {
      keywords: ['insolven', 'reorganizac', 'restrukturalizac', 'konkurs', 'oddlužen', 'věřitel', 'úpadek', 'odpůrčí', '182/2006'],
    },
    status: 'active',
    notes: 'FIR-25 rev 3 (2026-07-21, board reopen "you didnt get even one scrape from nss soud" — seen_all.json had 0 nss-sbirka entries, confirmed): the FIR-32 version keyword-filtered on the STAGE-2 detail page, so a full-archive pass had to fetch ~4740 detail pages — so slow/throttle-prone it was never run, so NSS surfaced nothing. Rev 3 moves the keyword filter to STAGE 1: the /cz/vyhledavani list HTML already carries, per decision, the headnote title + content snippet (the "právní věta", which opens with the cited-statute line incl. 182/2006 Sb.) + publish date. We parse those structured fields, filter on title+snippet, and only fetch the detail page for decisions that PASS — a full 474-page backfill now costs ~474 list fetches + a few dozen detail fetches (gentle enough to survive the site rate-limiting that a bulk detail-crawl triggers). Also now extracts the real pubDate (dd.mm.yyyy -> ISO) instead of null. Filtering on the headnote is safe for THIS curated source because the snippet reproduces the cited-statute line where insolvency relevance reliably appears. Weekly bound still config.maxPages (default 5 ≈ 50 newest); one-time seeding via config.fullBackfill / env NSS_SBIRKA_FULL_BACKFILL=1. Parser+flow validated via fixture/mock (parseListPage, parseCzDate, num-tag strip, pre-filter skips non-candidate detail fetch, seen-skip). Background: NSS has no RSS/API (nssoud.cz/rss soft-404, sbirka.nssoud.cz/rss 404); this is the curated Sbírka, NOT the full docket firehose at vyhledavac.nssoud.cz (deliberate precision/volume tradeoff for Tier B). ACTION STILL PENDING: run the one-time full backfill from a non-throttled env to seed history (NSS_SBIRKA_FULL_BACKFILL=1 node run.js) — my sandbox IP was rate-limited by this session\'s testing at deploy time.',
  },
  {
    id: 'zakonyprolidi-rss',
    name: 'zakonyprolidi.cz — newly promulgated legislation (nové vyhlášené předpisy)',
    tier: 'B',
    module: r('./rss-generic.js'),
    config: {
      feedUrl: 'https://www.zakonyprolidi.cz/cs/nove-predpisy.rss',
      keywords: ['insolven', 'reorganizac', 'restrukturalizac', 'konkurs', 'oddlužen', 'věřitel', 'úpadek', 'odpůrčí'],
      encoding: 'utf-8',
      userAgent: BROWSER_UA,  // site 403s any non-browser User-Agent (bot-block); see FIR-25
    },
    status: 'active',
    notes: 'Resolved FIR-25 (2026-07-21): the "nové vyhlášené předpisy" channel from zakonyprolidi.cz/rss is https://www.zakonyprolidi.cz/cs/nove-predpisy.rss. Verified live — valid RSS 2.0, UTF-8, current Sbírka zákonů items. The 403 on the earlier automated fetch was User-Agent bot-blocking: with a browser UA the feed returns 200, so config.userAgent is set to a browser UA. This channel lists ALL newly promulgated Sbírka zákonů predpisy, so the insolvency keyword filter is REQUIRED to avoid flooding the digest with unrelated legislation.',
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
