// Scraper for the Sbírka rozhodnutí Nejvyššího správního soudu (sbirka.nssoud.cz).
//
// Why a scraper and not RSS: NSS publishes NO RSS/API feed (confirmed FIR-25 —
// nssoud.cz/rss is a soft-404, sbirka.nssoud.cz/rss does not exist). But the
// Sbírka itself IS a clean, low-volume, editorially-curated collection of the
// most significant administrative-court decisions, each with a stable URL
// carrying a monotonic id (.../<slug>.p<NNNN>.html). We scrape the full
// searchable archive (FIR-32 — supersedes the earlier aktuální-vydání-only
// list stage, which silently missed everything but the single latest issue),
// enrich each decision from its detail page (headnote + statutes + legal
// thesis), keyword-filter, and hand the pipeline the same Item shape the RSS
// sources produce. The pipeline seen-store dedupes across runs (id = pNNNN),
// so each decision surfaces exactly once.
//
// Two-stage scrape:
//   Stage 1 — paginate /cz/vyhledavani search results (newest-first) to
//     collect decision ids + detail URLs. Because results are newest-first,
//     an incremental (weekly-monitoring) run can stop as soon as it hits a
//     page whose decisions are all already-seen, instead of walking the
//     entire ~474-page archive every run.
//   Stage 2 — fetch each detail page and extract headnote ("právní věta"),
//     cited statutes ("předpisy") and legal thesis. The search-results pages
//     do NOT carry full text, so keyword filtering MUST run against stage-2
//     content, not the slug — a tax/public-law decision can cite the
//     insolvenční zákon (182/2006 Sb.) without that showing up in its title.
//
// Relevance is Tier B: NSS is administrative law, so its overlap with the
// insolvency/restructuring specialization is secondary — mainly tax and other
// public-law claims asserted within insolvency proceedings.

const { BROWSER_UA } = require('./rss-generic');
const { withRetry } = require('../lib/retry');

const BASE = 'https://sbirka.nssoud.cz';
const SEARCH_URL = `${BASE}/cz/vyhledavani`;

// Weekly-monitoring default: stop after this many search-result pages even if
// none of them were fully seen yet (belt-and-braces bound, e.g. first-ever run
// with an empty seen-store). Override via config.maxPages.
const DEFAULT_MAX_PAGES = 5;
const DEFAULT_REQUEST_DELAY_MS = 300;

// _sort=datum*desc is required: the endpoint's default sort ("sort*desc",
// relevance) is NOT stable for an empty query — live testing (FIR-32) showed
// the same page number returning different, non-contiguous decision sets on
// repeated requests under the default sort (confirmed via the site's own
// sort <select name="_sort"> control, which offers "Řadit podle relevance"
// vs. "Řadit podle data"). Explicitly requesting date-descending makes page 1
// stable across repeated fetches and gives the newest-first ordering the
// incremental early-stop logic below depends on.
function searchPageUrl(page) {
  return `${SEARCH_URL}?q=&_filter_q=&_sort=datum*desc&_page=${page}`;
}

function decisionId(pid) {
  return `nss-sbirka-p${pid}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripHtml(s) {
  return (s || '')
    .replace(/<\?[^>]*\?>/g, ' ')       // strip <?links ...?> processing instructions
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchHtml(url) {
  return withRetry(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': BROWSER_UA },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
        return await res.text();
      } finally {
        clearTimeout(timer);
      }
    },
    { label: `nss-sbirka ${url}` }
  );
}

// Parse decision links from a search-results (or issue) listing page. Links
// look like /cz/<slug>.p<NNNN>.html (optionally with a ?q= suffix). Returns
// one entry per decision id, deduped, in first-seen (= newest-first) order.
function parseDecisionLinks(html) {
  const re = /href="(\/cz\/[^"?]*?\.p(\d+)\.html)/g;
  const byId = new Map();
  let m;
  while ((m = re.exec(html))) {
    const pid = m[2];
    if (!byId.has(pid)) {
      byId.set(pid, { pid: Number(pid), url: BASE + m[1] });
    }
  }
  return [...byId.values()];
}

// The search-results page paginates via links of the form
// /cz/vyhledavani?q=&_filter_q=&_page=N. The highest N found is the last page
// of the archive — parsed dynamically (it changes every issue), never
// hardcoded.
function parseMaxPage(html) {
  const re = /_page=(\d+)/g;
  let max = 1;
  let m;
  while ((m = re.exec(html))) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max;
}

// Pull a clean title + a rich text blob from a decision detail page. The blob
// (headnote heading + cited statutes + legal thesis) is used both as the digest
// summary and as the keyword-filter haystack.
function parseDecisionDetail(html) {
  const h2 = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  const titleFromH2 = h2 ? stripHtml(h2[1]) : '';

  // The curated legal content lives in <div CLASS="jud"> ... </div>. The CLASS
  // attribute is upper-cased by the source CMS, hence the case-insensitive match.
  const jud = html.match(/<div\s+class="jud"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
  const judText = jud ? stripHtml(jud[1]) : '';

  // Fallback title: the first "právní věta nadpis" (descriptive headnote title).
  let title = titleFromH2;
  if (!title) {
    const nadpis = html.match(/class="pravni-veta-nadpis"[^>]*>([\s\S]*?)<\/div>/i);
    if (nadpis) title = stripHtml(nadpis[1]);
  }
  return { title, text: judText };
}

function matchesKeywords(haystack, keywords) {
  if (!keywords || keywords.length === 0) return true;
  const hay = (haystack || '').toLowerCase();
  return keywords.some((kw) => hay.includes(kw.toLowerCase()));
}

// Contract matches rss-generic.fetchItems: returns
// { id, title, url, pubDate, summary, sourceId, sourceName }[]
//
// options.seenHasId: (id) => boolean — lets stage 1 stop paginating once a
// page's decisions are all already in the pipeline's seen-store, instead of
// walking the full archive every run. Passed in from run.js; defaults to
// "nothing seen" so the module still works standalone (e.g. a one-off backfill
// run outside the orchestrator).
// options.fullBackfill: true (or env NSS_SBIRKA_FULL_BACKFILL=1) walks the
// entire archive up to the dynamically-parsed last page — intended for a
// one-time initial crawl only, NOT for weekly monitoring.
async function fetchItems({
  keywords = [],
  sourceId,
  sourceName,
  maxPages = DEFAULT_MAX_PAGES,
  fullBackfill = process.env.NSS_SBIRKA_FULL_BACKFILL === '1',
  seenHasId = () => false,
  requestDelayMs = DEFAULT_REQUEST_DELAY_MS,
} = {}) {
  const collected = new Map(); // pid -> link

  let page = 1;
  for (;;) {
    const html = await fetchHtml(searchPageUrl(page));
    const links = parseDecisionLinks(html);

    if (links.length === 0) {
      if (page === 1) {
        // Layout changed — fail loudly so the monitor flags it rather than
        // silently reporting zero new NSS decisions forever.
        throw new Error('no decision links found on vyhledavani page 1 (layout change?)');
      }
      break; // paginated past the end of the archive
    }

    for (const link of links) {
      if (!collected.has(link.pid)) collected.set(link.pid, link);
    }

    const hardCap = fullBackfill ? parseMaxPage(html) : maxPages;
    const pageFullySeen = links.every((l) => seenHasId(decisionId(l.pid)));
    if (!fullBackfill && pageFullySeen) break; // caught up with a prior run
    if (page >= hardCap) break;

    page += 1;
    await sleep(requestDelayMs);
  }

  const items = [];
  for (const link of collected.values()) {
    const id = decisionId(link.pid);
    if (seenHasId(id)) continue; // already surfaced in a prior digest — skip the detail fetch

    let detail;
    try {
      detail = parseDecisionDetail(await fetchHtml(link.url));
    } catch (err) {
      // One unreachable detail page must not sink the whole source; fall back to
      // a slug-derived title so the decision can still surface if it matches.
      const slug = link.url.split('/').pop().replace(/\.p\d+\.html.*$/, '');
      detail = { title: slug.replace(/-/g, ' '), text: '' };
    }
    await sleep(requestDelayMs);

    const haystack = `${detail.title} ${detail.text}`;
    if (!matchesKeywords(haystack, keywords)) continue;

    const summary = detail.text.length > 600 ? detail.text.slice(0, 597) + '...' : detail.text;
    items.push({
      id,
      title: detail.title || `NSS rozhodnutí p${link.pid}`,
      url: link.url,
      // The search archive carries no reliable machine-readable publish date
      // per decision; seen-store dedup (id = pNNNN) makes an exact pubDate
      // non-essential here.
      pubDate: null,
      summary: summary || detail.title,
      sourceId,
      sourceName,
    });
  }
  return items;
}

module.exports = {
  fetchItems,
  parseDecisionLinks,
  parseDecisionDetail,
  parseMaxPage,
  searchPageUrl,
  SEARCH_URL,
};
