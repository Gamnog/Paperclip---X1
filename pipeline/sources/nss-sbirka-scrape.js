// Scraper for the Sbírka rozhodnutí Nejvyššího správního soudu (sbirka.nssoud.cz).
//
// Why a scraper and not RSS: NSS publishes NO RSS/API feed (confirmed FIR-25 —
// nssoud.cz/rss is a soft-404, sbirka.nssoud.cz/rss does not exist). But the
// Sbírka itself IS a clean, low-volume, editorially-curated collection of the
// most significant administrative-court decisions, each with a stable URL
// carrying a monotonic id (.../<slug>.p<NNNN>.html). We scrape the full
// searchable archive at /cz/vyhledavani, keyword-filter, and hand the pipeline
// the same Item shape the RSS sources produce. The pipeline seen-store dedupes
// across runs (id = pNNNN), so each decision surfaces exactly once.
//
// Two-stage scrape (FIR-25, rev 3 — pre-filtered):
//   Stage 1 — paginate /cz/vyhledavani search results (date-descending). Each
//     result row carries, IN THE LIST HTML, the decision's editorial headnote
//     TITLE, a content SNIPPET (the "právní věta", which opens with the cited
//     statutes line — e.g. "k § ... zákona č. 182/2006 Sb."), and the publish
//     DATE. We parse those structured fields and keyword-filter on
//     title+snippet HERE, at stage 1. This is the key change over the earlier
//     FIR-32 version, which fetched EVERY decision's detail page just to filter
//     (~4740 fetches for a full-archive pass) — that made the one-time backfill
//     so slow/throttle-prone it was never actually run, so NSS surfaced zero
//     decisions in the digest (the board push-back that reopened FIR-25).
//     Filtering on the headnote is safe for THIS source because the curated
//     Sbírka snippet reproduces the cited-statute line, where insolvency
//     relevance (182/2006 Sb. et al.) reliably appears — unlike a raw docket,
//     where relevance could hide in body text only.
//   Stage 2 — for decisions that PASS the stage-1 filter only, fetch the detail
//     page and extract the full headnote ("právní věta") + cited statutes for a
//     richer digest summary. Non-candidates are never detail-fetched, so a full
//     474-page backfill costs ~474 list fetches + a few dozen detail fetches
//     instead of ~4740 — gentle enough to survive the site's rate-limiting.
//
// Incremental bound: a normal (weekly) run stops after `maxPages` search-result
// pages (default 5 ≈ the 50 most-recent decisions) — ample headroom for a weekly
// cadence over this low-volume Sbírka. A one-time full backfill
// (config.fullBackfill / env NSS_SBIRKA_FULL_BACKFILL=1) walks the whole archive
// up to the dynamically-parsed last page to seed history. The seen-store dedupe
// (id = pNNNN) means each decision surfaces exactly once regardless of overlap.
//
// Relevance is Tier B: NSS is administrative law, so its overlap with the
// insolvency/restructuring specialization is secondary — mainly tax and other
// public-law claims asserted within insolvency proceedings.

const { BROWSER_UA } = require('./rss-generic');
const { withRetry } = require('../lib/retry');

const BASE = 'https://sbirka.nssoud.cz';
const SEARCH_URL = `${BASE}/cz/vyhledavani`;

// Weekly-monitoring default: stop after this many search-result pages. Override
// via config.maxPages. 5 pages ≈ 50 newest decisions — comfortably more than a
// weekly delta for this low-volume, editorially-curated collection.
const DEFAULT_MAX_PAGES = 5;
const DEFAULT_REQUEST_DELAY_MS = 300;

// _sort=datum*desc is required: the endpoint's default sort ("sort*desc",
// relevance) is NOT stable for an empty query — live testing (FIR-32) showed
// the same page number returning different, non-contiguous decision sets on
// repeated requests under the default sort. Explicitly requesting
// date-descending makes page 1 stable across repeated fetches and gives the
// newest-first ordering the weekly window relies on.
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
    .replace(/&#183;/g, '·')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/\s+/g, ' ')
    .trim();
}

// "15.04.2026" -> "2026-04-15T00:00:00.000Z" (UTC midnight, no TZ drift).
// Returns null for anything that isn't a dd.mm.yyyy date.
function parseCzDate(s) {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec((s || '').trim());
  if (!m) return null;
  const [, d, mo, y] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))).toISOString();
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

// Parse a search-results (vyhledavani) listing page into structured decision
// records. Each row is a <div class="list-item"> carrying the headnote title,
// a content snippet (the právní věta, opening with the cited-statute line), the
// publish date, and the detail-page link. Returns one record per decision id,
// deduped, in first-seen (= newest-first under date-desc sort) order.
//   { pid:Number, url:String, title:String, snippet:String, pubDate:ISO|null }
function parseListPage(html) {
  const blocks = String(html).split(/<div class="list-item">/i).slice(1);
  const byId = new Map();
  for (const blk of blocks) {
    const linkM = blk.match(/href="(\/cz\/[^"?]*?\.p(\d+)\.html)/i);
    if (!linkM) continue;
    const pid = Number(linkM[2]);
    if (byId.has(pid)) continue;

    // Title lives in <h3>; drop the leading <span class="num-tag"> (Sbírkové
    // číslo) so it doesn't get mashed into the title text.
    let h3 = (blk.match(/<h3>([\s\S]*?)<\/h3>/i) || [])[1] || '';
    h3 = h3.replace(/<span class="num-tag">[\s\S]*?<\/span>/i, ' ');
    const title = stripHtml(h3);

    const snippet = stripHtml((blk.match(/<p class="content"[^>]*>([\s\S]*?)<\/p>/i) || [])[1]);
    const dateRaw = (blk.match(/Datum:\s*<span>([\d.]+)<\/span>/i) || [])[1] || '';

    byId.set(pid, {
      pid,
      url: BASE + linkM[1],
      title,
      snippet,
      pubDate: parseCzDate(dateRaw),
    });
  }
  return [...byId.values()];
}

// Back-compat thin wrapper (older callers/tests expect {pid, url} only).
function parseDecisionLinks(html) {
  return parseListPage(html).map(({ pid, url }) => ({ pid, url }));
}

// The search-results page paginates via links of the form
// /cz/vyhledavani?...&_page=N. The highest N found is the last page of the
// archive — parsed dynamically (it changes every issue), never hardcoded.
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
// (headnote heading + cited statutes + legal thesis) is used as the digest
// summary for decisions that already passed the stage-1 keyword filter.
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
// options.seenHasId: (id) => boolean — checked against the pipeline seen-store.
// Used to skip decisions already surfaced in a prior digest (skips the stage-2
// detail fetch too). Passed in from run.js; defaults to "nothing seen" so the
// module still works standalone (e.g. a one-off backfill outside the orchestrator).
// options.fullBackfill: true (or env NSS_SBIRKA_FULL_BACKFILL=1) walks the
// entire archive up to the dynamically-parsed last page — intended for the
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
  // Stage 1: paginate the listing and keyword-filter on the headnote
  // (title + snippet) as we go. Only candidates are kept for a stage-2 fetch.
  const candidates = new Map(); // pid -> listing record (already keyword-matched)

  let page = 1;
  for (;;) {
    const html = await fetchHtml(searchPageUrl(page));
    const entries = parseListPage(html);

    if (entries.length === 0) {
      if (page === 1) {
        // Layout changed — fail loudly so the monitor flags it rather than
        // silently reporting zero new NSS decisions forever.
        throw new Error('no decision entries found on vyhledavani page 1 (layout change?)');
      }
      break; // paginated past the end of the archive
    }

    for (const e of entries) {
      if (candidates.has(e.pid)) continue;
      if (seenHasId(decisionId(e.pid))) continue; // already surfaced in a prior digest
      const listHay = `${e.title} ${e.snippet}`;
      if (matchesKeywords(listHay, keywords)) candidates.set(e.pid, e);
    }

    const hardCap = fullBackfill ? parseMaxPage(html) : maxPages;
    if (page >= hardCap) break;

    page += 1;
    await sleep(requestDelayMs);
  }

  // Stage 2: enrich each candidate from its detail page for a better summary.
  const items = [];
  for (const e of candidates.values()) {
    let detail;
    try {
      detail = parseDecisionDetail(await fetchHtml(e.url));
      await sleep(requestDelayMs);
    } catch (err) {
      // One unreachable detail page must not sink the source; fall back to the
      // listing-level headnote (title + snippet), which already matched.
      detail = { title: e.title, text: e.snippet };
    }

    const summaryText = detail.text || e.snippet || detail.title || e.title;
    const summary = summaryText.length > 600 ? summaryText.slice(0, 597) + '...' : summaryText;
    items.push({
      id: decisionId(e.pid),
      title: detail.title || e.title || `NSS rozhodnutí p${e.pid}`,
      url: e.url,
      pubDate: e.pubDate, // real publish date from the listing (dd.mm.yyyy -> ISO)
      summary: summary || e.title,
      sourceId,
      sourceName,
    });
  }
  return items;
}

module.exports = {
  fetchItems,
  parseListPage,
  parseDecisionLinks,
  parseDecisionDetail,
  parseMaxPage,
  parseCzDate,
  searchPageUrl,
  SEARCH_URL,
};
