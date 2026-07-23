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

// FIR-37 (CEO decision, 2026-07-23): store the FULL ruling body — this is NOT a
// content cap, only a runaway guard against a pathologically large / malformed
// detail page. Real Sbírka rulings top out ~12k chars, so this never trims real
// content.
//
// History: "Option A — keep it all on GitHub" first stored full bodies in a single
// data/nss_sbirka_cache.json, which grew to 103 MB and hit GitHub's HARD 100 MB
// per-file limit (pre-receive reject). The CEO's follow-up direction was: "do A but
// limit the max file size to 90mb so it creates a new file; don't split one
// decision between 2 files." So the corpus is now SHARDED across
// data/nss_sbirka_cache/shard-NNN.json — full text kept in git, each shard under
// SHARD_MAX_BYTES (< the 100 MB limit), each decision written WHOLE into exactly
// one shard (never split across files). See saveCache/partitionIntoShards below.
const MAX_CACHE_TEXT_CHARS = 1000000; // ~2 MB UTF-8 worst case; guards against a malformed page, not real content

// Max serialized bytes per shard file. Kept comfortably under GitHub's hard 100 MB
// per-file limit so a committed shard is never rejected at push. When appending the
// next decision would push a shard past this, a new shard is started; a single
// decision is never split across shards. Overridable in tests via
// NSS_SBIRKA_SHARD_MAX_BYTES.
const SHARD_MAX_BYTES = 90 * 1024 * 1024; // 90 MB

// Cache schema version for the stored body text. Bumped to 2 by FIR-36/FIR-37:
// v2 entries hold the FULL <div class="jud"> body; entries written before the
// fix (v absent / <2) hold only the ~470-char headnote and must be re-fetched to
// rebuild the full-text corpus. Stage 2 and refreshCorpus() treat a v<2 entry as
// stale and re-scrape it; a v2 entry is trusted and skipped (keeps re-runs cheap).
const FULLTEXT_CACHE_VERSION = 2;

// A cache entry is "fresh" — usable without re-fetching — only when it carries
// full text at the current schema version. Missing/old-version entries are stale.
function isFreshCacheEntry(entry) {
  return !!entry && typeof entry.text === 'string' && (entry.v || 0) >= FULLTEXT_CACHE_VERSION;
}

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

// The sharded cache lives in a directory derived from the cache path by stripping
// the trailing .json: data/nss_sbirka_cache.json -> data/nss_sbirka_cache/. Each
// shard is data/nss_sbirka_cache/shard-NNN.json. (If the path has no .json suffix
// we append `.shards` so the directory never collides with the legacy file.)
function shardDirFor(cachePath) {
  const stripped = cachePath.replace(/\.json$/i, '');
  return stripped === cachePath ? `${cachePath}.shards` : stripped;
}

function shardFileName(i) {
  return `shard-${String(i).padStart(3, '0')}.json`;
}

// Load the full pid->entry map. FIR-37: the corpus is sharded across
// <cacheDir>/shard-NNN.json. For backward-compat we ALSO read the legacy single
// file (data/nss_sbirka_cache.json) if it is still present — the first saveCache
// after the migration writes the shards and deletes it. When both exist (only
// transiently, mid-migration) shard entries win, since shards are the
// post-migration source of truth.
function loadCache(cachePath) {
  const merged = {};
  // Legacy pre-sharding single-file cache.
  try {
    Object.assign(merged, JSON.parse(fs.readFileSync(cachePath, 'utf8')) || {});
  } catch { /* missing/corrupt legacy file -> ignore */ }
  // Sharded cache.
  const dir = shardDirFor(cachePath);
  let files;
  try { files = fs.readdirSync(dir); } catch { files = []; }
  for (const f of files.filter((n) => /^shard-\d+\.json$/i.test(n)).sort()) {
    try {
      Object.assign(merged, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) || {});
    } catch (err) {
      console.warn(`[nss-sbirka] cache shard ${f} unreadable: ${err.message} — skipping`);
    }
  }
  return merged;
}

// Partition the pid->entry map into shard objects, each serializing to at most
// maxBytes, WITHOUT ever splitting a single decision across shards (the CEO's
// "don't split one decision between 2 files"). Pids are emitted in numeric order
// for a stable, human-readable layout so successive saves diff cleanly. The byte
// accounting is exact for JSON.stringify(shard) with no whitespace: 2 bytes for
// the enclosing braces, each entry `"pid":<value>`, entries joined by commas. A
// lone decision larger than maxBytes still gets its own shard (never split) — real
// rulings are ~12k chars so this cannot happen in practice, but it degrades safely.
function partitionIntoShards(cache, maxBytes) {
  const pids = Object.keys(cache).sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : String(a).localeCompare(String(b));
  });
  const shards = [];
  let cur = null;
  let curBytes = 0;
  for (const pid of pids) {
    const pieceBytes = Buffer.byteLength(
      `${JSON.stringify(String(pid))}:${JSON.stringify(cache[pid])}`,
      'utf8'
    );
    // Adding to an existing shard costs the piece + a joining comma; starting a
    // fresh shard costs the piece + the two enclosing braces.
    if (cur && curBytes + pieceBytes + 1 > maxBytes) {
      shards.push(cur);
      cur = null;
    }
    if (!cur) {
      cur = {};
      curBytes = pieceBytes + 2; // first entry + "{" "}"
    } else {
      curBytes += pieceBytes + 1; // subsequent entry + ","
    }
    cur[pid] = cache[pid];
  }
  if (cur) shards.push(cur);
  return shards;
}

function saveCache(cachePath, cache) {
  const maxBytes = Number(process.env.NSS_SBIRKA_SHARD_MAX_BYTES) || SHARD_MAX_BYTES;
  const dir = shardDirFor(cachePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const shards = partitionIntoShards(cache, maxBytes);
    // Write each shard atomically (tmp + rename) so an interrupted save never
    // leaves a half-written shard for loadCache to choke on.
    shards.forEach((shard, i) => {
      const target = path.join(dir, shardFileName(i));
      const tmp = `${target}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(shard, null, 0), 'utf8');
      fs.renameSync(tmp, target);
    });
    // Drop orphaned shard files beyond the count we just wrote (the corpus may
    // re-partition into fewer shards as boundaries shift); otherwise loadCache
    // would merge stale pids back in.
    let existing;
    try { existing = fs.readdirSync(dir); } catch { existing = []; }
    for (const f of existing) {
      const m = /^shard-(\d+)\.json$/i.exec(f);
      if (m && Number(m[1]) >= shards.length) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* best effort */ }
      }
    }
    // Migration: once shards are written, remove the legacy single-file cache so
    // it isn't merged back on the next load (and so git records the move).
    if (cachePath !== dir) {
      try { if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath); } catch { /* best effort */ }
    }
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

// Extract the inner HTML of the first <div class="jud"> by walking nested
// <div>/</div> to the *matching* close. This is deliberately NOT a regex:
// the jud container wraps BOTH the headnote (právní věta) and the full ruling
// reasoning (odůvodnění) in nested <div>s, so a non-greedy regex to the first
// `</div></div>` stopped at the end of the headnote block and captured only
// ~470 chars of an 11k-char ruling (FIR-36). Returns '' when the div is absent;
// on an unbalanced/truncated page it returns everything after the open tag.
function extractJudInner(html) {
  const open = /<div\s+class="jud"[^>]*>/i.exec(html);
  if (!open) return '';
  const start = open.index + open[0].length;
  const tag = /<div\b[^>]*>|<\/div\s*>/gi;
  tag.lastIndex = start;
  let depth = 1;
  let m;
  while ((m = tag.exec(html))) {
    if (m[0][1] === '/') {
      depth -= 1;
      if (depth === 0) return html.slice(start, m.index);
    } else {
      depth += 1;
    }
  }
  return html.slice(start);
}

// Pull a clean title + the full ruling text from a decision detail page. The
// text is the entire <div class="jud"> body (headnote + cited statutes + full
// reasoning) — used both by the relevance classifier and as the digest summary
// source.
function parseDecisionDetail(html) {
  const h2 = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  const titleFromH2 = h2 ? stripHtml(h2[1]) : '';

  // The curated legal content lives in <div CLASS="jud"> ... </div>. The CLASS
  // attribute is upper-cased by the source CMS, hence the case-insensitive match.
  const judText = stripHtml(extractJudInner(html));

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
    (e) => isFreshCacheEntry(cache[e.pid])
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
    if (isFreshCacheEntry(cache[e.pid])) continue; // already scraped at the current full-text version
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
      v: FULLTEXT_CACHE_VERSION,
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

// FIR-37 one-time full-text corpus rebuild. The existing cache already holds a
// pid for (essentially) every decision in the archive, but with pre-fix
// headnote-only bodies (v<2). This walks those KNOWN pids directly and re-fetches
// each detail page for the full <div class="jud"> body — deliberately WITHOUT the
// stage-1 search pagination or stage-3 classification of fetchItems, because:
//   - the pids are already known (the cache is the work list), so ~4740 listing
//     fetches are pure waste here, and
//   - the seen-store is already seeded from the earlier backfill, so re-running
//     the ~4700 Haiku classify calls just to rebuild BODIES is waste too.
// That is what makes this re-crawl fast (~2h vs the ~5-7h full backfill) without
// touching the FIR-25 429-safe request pacing. Resumable: v2 entries are skipped,
// the cache is flushed incrementally, and a long stretch of failures stops the
// run so it commits progress and a re-run picks up where it left off.
//
// options.cachePath  — override the cache location (tests).
// options.requestDelayMs — override inter-request pacing (tests pass 0).
// options.limit — cap how many entries to refresh (tests / partial runs).
async function refreshCorpus({
  cachePath = DEFAULT_CACHE_PATH,
  requestDelayMs,
  limit = Infinity,
} = {}) {
  const delayMs = requestDelayMs != null
    ? requestDelayMs
    : (Number(process.env.NSS_SBIRKA_REQUEST_DELAY_MS) || BACKFILL_REQUEST_DELAY_MS);

  const cache = loadCache(cachePath);
  const pids = Object.keys(cache);
  const stale = pids.filter((pid) => !isFreshCacheEntry(cache[pid]));
  console.log(
    `[nss-sbirka] corpus refresh: ${pids.length} cached decision(s); ` +
      `${stale.length} need a full-body re-fetch (v<${FULLTEXT_CACHE_VERSION}); ` +
      `pacing ${delayMs}ms/request`
  );

  let refreshed = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  let sinceFlush = 0;
  let processed = 0;
  for (const pid of stale) {
    if (refreshed >= limit) break;
    processed += 1;
    const entry = cache[pid] || {};
    if (!entry.url) {
      // Can't re-fetch without the stored detail URL; leave it stale.
      console.warn(`[nss-sbirka] corpus refresh: p${pid} has no cached url — skipping`);
      continue;
    }
    let detail;
    try {
      detail = parseDecisionDetail(await fetchHtml(entry.url));
      consecutiveFailures = 0;
    } catch (err) {
      failed += 1;
      console.warn(`[nss-sbirka] corpus refresh: p${pid} fetch failed: ${err.message} — leaving stale, retry on re-run`);
      if (++consecutiveFailures >= MAX_CONSECUTIVE_PAGE_FAILURES) {
        console.warn(`[nss-sbirka] corpus refresh: ${consecutiveFailures} consecutive failures — stopping; a re-run resumes from the committed cache`);
        break;
      }
      await sleep(delayMs);
      continue;
    }
    cache[pid] = {
      ...entry,
      title: detail.title || entry.title || '',
      text: String(detail.text || entry.text || '').slice(0, MAX_CACHE_TEXT_CHARS),
      v: FULLTEXT_CACHE_VERSION,
      refreshedAt: new Date().toISOString(),
    };
    refreshed += 1;
    if (processed % PROGRESS_EVERY_ITEMS === 0) {
      console.log(`[nss-sbirka] corpus refresh: ${processed}/${stale.length} processed, ${refreshed} refreshed, ${failed} failed`);
    }
    if (++sinceFlush >= CACHE_SAVE_EVERY) {
      saveCache(cachePath, cache);
      sinceFlush = 0;
    }
    await sleep(delayMs);
  }
  if (sinceFlush > 0) saveCache(cachePath, cache);

  const remaining = Object.keys(cache).filter((pid) => !isFreshCacheEntry(cache[pid])).length;
  console.log(
    `[nss-sbirka] corpus refresh done: ${refreshed} refreshed, ${failed} failed this run, ${remaining} still stale`
  );
  return { total: pids.length, staleAtStart: stale.length, refreshed, failed, remaining };
}

// FIR-38 one-time re-classification of the rebuilt full-text corpus.
//
// Why this exists: the FIR-25/FIR-33 backfill classified each decision over the
// FIR-36 headnote-only body (~470 chars). The whole FIR-33 premise is that
// insolvency relevance can live in the ruling BODY, not just the headnote — so
// that seed classification almost certainly REJECTED some body-relevant
// decisions that were never seeded into the seen-store. FIR-37 rebuilt the
// corpus with full v2 bodies; this pass re-runs the classifier over the full
// body of every cached-but-not-yet-seen decision and seeds any that now qualify.
//
// Key property: NO NSS network fetches — it reads the committed cache — so it is
// fast, cheap, and carries zero 429 risk (the crawl is network-bound; this is
// purely API-bound against Anthropic). Cleanly decoupled from refreshCorpus.
//
// Resumability: every classified pid is recorded in an external `ledger`
// (pid -> { relevant, v, at }); a decision already in the ledger at the current
// corpus version, or already in the seen-store, is skipped — so a re-run never
// re-pays for work already done. Newly-relevant decisions are marked seen via
// the injected `seen` immediately (default SEED-ONLY: marked seen, NOT emailed;
// whether any should also be surfaced in a digest is a CEO product call). The
// caller persists `ledger` + `seen` in the `persist` callback, invoked
// incrementally so an interrupted run keeps its progress.
//
// options.cachePath  — override the cache location (tests).
// options.classifier — injectable { classify({title,text}) -> {relevant,reason} }.
// options.keywords   — offline fallback keywords when no classifier injected.
// options.seen       — { has(id), markSeen(id, meta) } (a SeenStore; stub in tests).
// options.ledger     — mutated in place: pid -> { relevant, v, at }.
// options.persist    — () => void, called every CACHE_SAVE_EVERY seeds and at end.
// options.requestDelayMs — inter-call pacing (default 0; env NSS_RECLASSIFY_DELAY_MS).
// options.limit      — cap classifications this run (tests / partial runs).
async function reclassifyCorpus({
  cachePath = DEFAULT_CACHE_PATH,
  classifier,
  keywords = [],
  seen = { has: () => false, markSeen: () => {} },
  ledger = {},
  persist = () => {},
  requestDelayMs,
  limit = Infinity,
} = {}) {
  const clf = classifier || makeClassifier({ keywords });
  const delayMs = requestDelayMs != null
    ? requestDelayMs
    : (Number(process.env.NSS_RECLASSIFY_DELAY_MS) || 0);

  const cache = loadCache(cachePath);
  const pids = Object.keys(cache);

  // A decision still carrying a pre-fix (v<2) headnote-only body must NOT be
  // classified — that is exactly the recall bug this pass exists to fix. Skip &
  // count them so the operator knows to finish the corpus refresh (FIR-37) first.
  const staleCount = pids.filter((pid) => !isFreshCacheEntry(cache[pid])).length;

  // Candidates: full-text (v2) decisions not already surfaced/seeded and not
  // already classified at the current corpus version.
  const candidates = pids.filter((pid) => {
    if (!isFreshCacheEntry(cache[pid])) return false;
    if (seen.has(decisionId(pid))) return false;
    const led = ledger[pid];
    if (led && (led.v || 0) >= FULLTEXT_CACHE_VERSION) return false;
    return true;
  });

  console.log(
    `[nss-sbirka] reclassify: ${pids.length} cached decision(s); ` +
      `${staleCount} still headnote-only (skipped — run corpus refresh first); ` +
      `${candidates.length} to (re)classify; classifier=${clf.kind}`
  );

  const newlyRelevant = [];
  let classified = 0;
  let relevant = 0;
  let sinceFlush = 0;
  for (const pid of candidates) {
    if (classified >= limit) break;
    const e = cache[pid] || {};
    const title = e.title || `NSS rozhodnutí p${pid}`;
    const text = e.text || '';

    let verdict;
    try {
      verdict = await clf.classify({ title, text });
    } catch (err) {
      // classify() retries + falls back internally; a throw here is unexpected.
      // Do NOT ledger it — leave it for a re-run to retry — and don't crash.
      console.warn(`[nss-sbirka] reclassify: classify threw for p${pid}: ${err.message} — leaving unclassified, retry on re-run`);
      continue;
    }
    classified += 1;
    const isRelevant = !!(verdict && verdict.relevant);
    ledger[pid] = { relevant: isRelevant, v: FULLTEXT_CACHE_VERSION, at: new Date().toISOString() };

    if (isRelevant) {
      relevant += 1;
      // SEED-ONLY: mark seen so it is treated as history and NOT re-dumped as
      // "new this week"; this does not email anyone.
      seen.markSeen(decisionId(pid), {
        title,
        url: e.url,
        sourceId: 'nss-sbirka',
        pubDate: e.pubDate,
        via: 'fir38-reclassify',
      });
      const summaryText = text || title;
      const summary = summaryText.length > 600 ? summaryText.slice(0, 597) + '...' : summaryText;
      newlyRelevant.push({
        id: decisionId(pid),
        pid: Number(pid),
        title,
        url: e.url,
        pubDate: e.pubDate,
        summary,
        reason: verdict && verdict.reason,
      });
    }

    if (classified % PROGRESS_EVERY_ITEMS === 0) {
      console.log(`[nss-sbirka] reclassify: ${classified}/${candidates.length} classified, ${relevant} newly relevant so far`);
    }
    if (++sinceFlush >= CACHE_SAVE_EVERY) {
      persist();
      sinceFlush = 0;
    }
    if (delayMs) await sleep(delayMs);
  }
  if (sinceFlush > 0) persist();

  const remaining = candidates.length - classified;
  console.log(
    `[nss-sbirka] reclassify done: ${classified} classified, ${relevant} newly relevant (seeded), ${remaining} candidate(s) left for a re-run`
  );
  return {
    total: pids.length,
    staleCount,
    candidates: candidates.length,
    classified,
    newlyRelevant,
    remaining,
  };
}

module.exports = {
  fetchItems,
  refreshCorpus,
  reclassifyCorpus,
  isFreshCacheEntry,
  loadCache,
  saveCache,
  shardDirFor,
  partitionIntoShards,
  FULLTEXT_CACHE_VERSION,
  SHARD_MAX_BYTES,
  parseListPage,
  parseDecisionLinks,
  parseDecisionDetail,
  extractJudInner,
  parseMaxPage,
  parseCzDate,
  searchPageUrl,
  SEARCH_URL,
};
