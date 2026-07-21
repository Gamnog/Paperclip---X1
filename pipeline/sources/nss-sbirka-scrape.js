// Scraper for the Sbírka rozhodnutí Nejvyššího správního soudu (sbirka.nssoud.cz).
//
// Why a scraper and not RSS: NSS publishes NO RSS/API feed (confirmed FIR-25 —
// nssoud.cz/rss is a soft-404, sbirka.nssoud.cz/rss does not exist). But the
// Sbírka itself IS a clean, low-volume, editorially-curated collection of the
// most significant administrative-court decisions, each with a stable URL
// carrying a monotonic id (.../<slug>.p<NNNN>.html). We scrape the full
// searchable archive at /cz/vyhledavani and hand the pipeline the same Item
// shape the RSS sources produce. The pipeline seen-store dedupes across runs
// (id = pNNNN), so each decision surfaces exactly once.
//
// Three-stage scrape (FIR-33, rev 4 — classifier, NO keyword pre-filter):
//   Stage 1 — paginate /cz/vyhledavani search results (date-descending) and
//     collect EVERY unseen decision. Per the CEO's 2026-07-21 directive there
//     is no keyword pre-filter: a keyword gate on the headnote misses decisions
//     whose insolvency relevance lives in the body only, so relevance is
//     decided later, by the classifier, over the full text.
//   Stage 2 — detail-fetch every candidate, extract the full ruling body from
//     <div class="jud">, and cache it (data/nss_sbirka_cache.json, keyed by
//     pid). Cached pids are never re-fetched; the cache is flushed
//     incrementally so a throttled/interrupted full-archive backfill resumes
//     from committed progress instead of restarting the ~4740-page crawl.
//   Stage 3 — classify each candidate's full text via lib/classify.js (Claude
//     Haiku when ANTHROPIC_API_KEY is set, else an offline keyword fallback).
//     Only decisions marked relevant are returned.
//
// Cost/throttle note: fetching every decision's detail page is heavier than the
// FIR-32 headnote pre-filter it replaces (this is the tradeoff the CEO chose:
// recall over fetch-count). For the WEEKLY run this is bounded (newest ~50). For
// the one-time full backfill it is ~4740 detail fetches + ~4740 Haiku calls; the
// incremental cache makes that safely resumable across CI re-runs.
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

const path = require('path');
const fs = require('fs');
const { BROWSER_UA } = require('./rss-generic');
const { withRetry } = require('../lib/retry');
const { makeClassifier } = require('../lib/classify');

const BASE = 'https://sbirka.nssoud.cz';
const SEARCH_URL = `${BASE}/cz/vyhledavani`;

// Persisted text cache so a run (esp. the one-time full backfill) never
// re-fetches a decision detail page it already scraped: keyed by pid ->
// { url, title, pubDate, text, scrapedAt }. Saved incrementally so an
// interrupted/throttled backfill resumes from committed progress on re-run.
const DEFAULT_CACHE_PATH = path.join(__dirname, '..', 'data', 'nss_sbirka_cache.json');
const CACHE_SAVE_EVERY = 25; // flush after this many new detail fetches

// Bound the cached body text: the classifier and the digest summary each need
// only a head slice, and committing full rulings for the whole archive would
// bloat the repo. Enough to preserve the relevance signal.
const MAX_CACHE_TEXT_CHARS = 6000;

// Weekly-monitoring default: stop after this many search-result pages. Override
// via config.maxPages. 5 pages ≈ 50 newest decisions — comfortably more than a
// weekly delta for this low-volume, editorially-curated collection.
const DEFAULT_MAX_PAGES = 5;
// Inter-request pacing. The weekly delta is ~50 fetches so a small gap is fine,
// but the one-time full-archive backfill fires thousands of sequential requests
// at a court server that rate-limits anonymous crawlers (HTTP 429 — see FIR-25):
// crawling at 300ms tripped the limiter and the whole run died. Pace the backfill
// far more conservatively (override with env NSS_SBIRKA_REQUEST_DELAY_MS).
const DEFAULT_REQUEST_DELAY_MS = 300;
const BACKFILL_REQUEST_DELAY_MS = 1200;
// Stage-1 circuit breaker: if the server hard-blocks this many pages in a row,
// stop paginating so the run ends and commits its progress (the incremental
// cache) instead of grinding through hundreds of failing pages; a later re-run
// resumes from the committed cache.
const MAX_CONSECUTIVE_PAGE_FAILURES = 5;

// Progress-log cadence for the long full-archive backfill (weekly runs are tiny
// and stay quiet). Purely observability: a multi-hour crawl that only logs
// "starting" then nothing for an hour is indistinguishable from a hang.
const PROGRESS_EVERY_PAGES = 25;
const PROGRESS_EVERY_ITEMS = 50;

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

function loadCache(cachePath) {
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8')) || {};
  } catch {
    return {}; // missing/corrupt cache -> start fresh
  }
}

function saveCache(cachePath, cache) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 0), 'utf8');
  } catch (err) {
    // Cache is an optimization, not correctness — never let a write failure
    // sink the whole scrape.
    console.warn(`[nss-sbirka] cache write failed: ${err.message}`);
  }
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

// Retryable statuses: rate-limit (429) and 5xx server errors are transient. A
// deliberate 4xx (403/404) will not change on retry, so we give up immediately
// rather than burning backoff on it (a dead detail page falls back to snippet).
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

// Parse a Retry-After header (delta-seconds or HTTP-date) into ms. Guards a
// missing/mock `headers` object. Returns null when absent/unparseable.
function parseRetryAfterMs(res) {
  const raw = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

async function fetchHtml(url) {
  return withRetry(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': BROWSER_UA },
        });
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status} from ${url}`);
          err.status = res.status;
          const retryAfterMs = parseRetryAfterMs(res);
          if (retryAfterMs != null) err.retryAfterMs = retryAfterMs;
          throw err;
        }
        return await res.text();
      } finally {
        clearTimeout(timer);
      }
    },
    {
      label: `nss-sbirka ${url}`,
      // 429-tolerant: 5 tries with exponential backoff (2s,4s,8s,16s ≈ 30s of
      // cool-down), honouring a server Retry-After when present. Network/timeout
      // errors (no .status) are retried; a deliberate 4xx is not.
      attempts: 5,
      delayMs: 2000,
      factor: 2,
      maxDelayMs: 60000,
      shouldRetry: (err) => err.status == null || isRetryableStatus(err.status),
    }
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

// Contract matches rss-generic.fetchItems: returns
// { id, title, url, pubDate, summary, sourceId, sourceName }[]
//
// Three stages (FIR-33, rev 4 — classifier, no keyword pre-filter):
//   Stage 1 — paginate the listing and collect EVERY unseen decision. There is
//     NO keyword pre-filter (the CEO's 2026-07-21 directive): a keyword gate on
//     the headnote misses decisions whose insolvency relevance lives in the
//     body only, so every unseen decision becomes a candidate.
//   Stage 2 — detail-fetch each candidate, extract the full ruling body from
//     <div class="jud">, and cache it (data/nss_sbirka_cache.json, keyed by
//     pid). Cached pids are NOT re-fetched, so a re-run / resumed backfill is
//     cheap, and the cache is flushed incrementally so an interrupted backfill
//     keeps its progress.
//   Stage 3 — classify each candidate's full text via the injectable
//     `classifier` (defaults to makeClassifier from lib/classify.js: Claude
//     Haiku when ANTHROPIC_API_KEY is set, else the offline keyword heuristic).
//     Only decisions the classifier marks relevant are returned.
//
// options.seenHasId: (id) => boolean — checked against the pipeline seen-store;
//   already-surfaced decisions skip the detail fetch AND classification.
// options.fullBackfill: true (or env NSS_SBIRKA_FULL_BACKFILL=1) walks the
//   entire archive up to the dynamically-parsed last page — one-time seeding
//   only, NOT weekly monitoring.
// options.classifier: injectable { classify(item)->{relevant} } for tests.
// options.cachePath: override the text-cache location (tests).
async function fetchItems({
  keywords = [],
  sourceId,
  sourceName,
  maxPages = DEFAULT_MAX_PAGES,
  fullBackfill = process.env.NSS_SBIRKA_FULL_BACKFILL === '1',
  seenHasId = () => false,
  requestDelayMs,
  classifier,
  cachePath = DEFAULT_CACHE_PATH,
} = {}) {
  const clf = classifier || makeClassifier({ keywords });

  // Resolve inter-request pacing: explicit arg (tests pass 0) wins; else an env
  // override; else a conservative default that is much gentler for the heavy
  // full-archive backfill than for the tiny weekly delta.
  const delayMs = requestDelayMs != null
    ? requestDelayMs
    : (Number(process.env.NSS_SBIRKA_REQUEST_DELAY_MS) || (fullBackfill ? BACKFILL_REQUEST_DELAY_MS : DEFAULT_REQUEST_DELAY_MS));

  // Stage 1: paginate the listing and collect every UNSEEN decision. No
  // keyword pre-filter — the classifier decides relevance later.
  const candidates = new Map(); // pid -> listing record

  let page = 1;
  // For a full backfill the last page is resolved once, from page 1's pagination
  // links (a page that later fails to fetch has no html to re-derive it from).
  let hardCap = fullBackfill ? Infinity : maxPages;
  let consecutiveFailures = 0;
  for (;;) {
    let html;
    try {
      html = await fetchHtml(searchPageUrl(page));
      consecutiveFailures = 0;
    } catch (err) {
      // Weekly runs are tiny and must be reliable, so surface the failure. Page
      // 1 is fatal either way (we can't even size the archive). But for the
      // heavy full backfill a single throttled page must NOT sink the whole
      // seeding run: skip it — a later re-run re-walks from page 1 and retries
      // it — and stop entirely if the server hard-blocks a long stretch, so the
      // run ends and commits its progress rather than grinding through failures.
      if (!fullBackfill || page === 1) throw err;
      console.warn(`[nss-sbirka] stage-1 page ${page} failed after retries: ${err.message} — skipping`);
      if (++consecutiveFailures >= MAX_CONSECUTIVE_PAGE_FAILURES) {
        console.warn(`[nss-sbirka] ${consecutiveFailures} consecutive stage-1 page failures — stopping pagination early; a re-run resumes from the committed cache`);
        break;
      }
      if (page >= hardCap) break;
      page += 1;
      await sleep(delayMs);
      continue;
    }

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
      candidates.set(e.pid, e);
    }

    // Resolve the backfill's last page once, from the first page's links.
    if (fullBackfill && !Number.isFinite(hardCap)) {
      hardCap = parseMaxPage(html);
      console.log(`[nss-sbirka] stage 1: walking ${hardCap} search page(s) (date-desc)`);
    }
    // Heartbeat: the full backfill paginates hundreds of pages with no other
    // output, so a silent run looks hung. Emit a periodic progress line so the
    // operator can see it is advancing (weekly runs are ~5 pages -> no noise).
    if (fullBackfill && page % PROGRESS_EVERY_PAGES === 0) {
      console.log(`[nss-sbirka] stage 1: page ${page}/${hardCap}, ${candidates.size} candidate(s) so far`);
    }
    if (page >= hardCap) break;

    page += 1;
    await sleep(delayMs);
  }

  // Stage 2: detail-fetch every candidate not already cached; extract & cache
  // the full ruling body. Flush the cache incrementally so a throttled/timed-out
  // backfill resumes from committed progress.
  const cache = loadCache(cachePath);
  let fetchedSinceFlush = 0;
  const totalCandidates = candidates.size;
  const alreadyCached = [...candidates.values()].filter(
    (e) => cache[e.pid] && typeof cache[e.pid].text === 'string'
  ).length;
  console.log(
    `[nss-sbirka] stage 1 done: ${totalCandidates} unseen candidate(s) ` +
      `(${alreadyCached} already cached); stage 2 detail-fetching the rest…`
  );
  let detailProcessed = 0;
  for (const e of candidates.values()) {
    detailProcessed += 1;
    if (fullBackfill && detailProcessed % PROGRESS_EVERY_ITEMS === 0) {
      console.log(`[nss-sbirka] stage 2: ${detailProcessed}/${totalCandidates} candidate(s) processed`);
    }
    if (cache[e.pid] && typeof cache[e.pid].text === 'string') continue; // already scraped
    let detail;
    try {
      detail = parseDecisionDetail(await fetchHtml(e.url));
      await sleep(delayMs);
    } catch (err) {
      // Detail page unreachable (throttled / genuinely gone): classify on the
      // listing snippet for THIS run (stage 3 falls back to e.snippet), but do
      // NOT cache — caching the degraded snippet as the body would make every
      // re-run skip the real detail fetch, permanently poisoning the cache.
      // Leaving it uncached lets a later re-run retry the real body.
      console.warn(`[nss-sbirka] detail fetch failed for p${e.pid}: ${err.message} — using snippet, not caching`);
      continue;
    }
    cache[e.pid] = {
      url: e.url,
      title: detail.title || e.title || '',
      pubDate: e.pubDate,
      text: String(detail.text || e.snippet || '').slice(0, MAX_CACHE_TEXT_CHARS),
      scrapedAt: new Date().toISOString(),
    };
    if (++fetchedSinceFlush >= CACHE_SAVE_EVERY) {
      saveCache(cachePath, cache);
      fetchedSinceFlush = 0;
    }
  }
  if (fetchedSinceFlush > 0) saveCache(cachePath, cache);

  // Stage 3: classify each candidate's full text; keep only the relevant ones.
  console.log(`[nss-sbirka] stage 2 done; stage 3 classifying ${candidates.size} candidate(s)…`);
  const items = [];
  let classified = 0;
  for (const e of candidates.values()) {
    classified += 1;
    if (fullBackfill && classified % PROGRESS_EVERY_ITEMS === 0) {
      console.log(`[nss-sbirka] stage 3: ${classified}/${candidates.size} classified, ${items.length} relevant so far`);
    }
    const c = cache[e.pid] || {};
    const title = c.title || e.title || `NSS rozhodnutí p${e.pid}`;
    const text = c.text || e.snippet || '';

    let verdict;
    try {
      verdict = await clf.classify({ title, text });
    } catch (err) {
      // classify() already retries+falls back internally; a throw here is
      // unexpected. Skip this decision rather than crash the whole source.
      console.warn(`[nss-sbirka] classify threw for p${e.pid}: ${err.message} — skipping`);
      continue;
    }
    await sleep(delayMs);
    if (!verdict || !verdict.relevant) continue;

    const summaryText = text || title;
    const summary = summaryText.length > 600 ? summaryText.slice(0, 597) + '...' : summaryText;
    items.push({
      id: decisionId(e.pid),
      title,
      url: e.url,
      pubDate: c.pubDate || e.pubDate, // real publish date (dd.mm.yyyy -> ISO)
      summary: summary || title,
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
