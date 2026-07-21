// Scraper for the Sbírka rozhodnutí Nejvyššího správního soudu (sbirka.nssoud.cz).
//
// Why a scraper and not RSS: NSS publishes NO RSS/API feed (confirmed FIR-25 —
// nssoud.cz/rss is a soft-404, sbirka.nssoud.cz/rss does not exist). But the
// Sbírka itself IS a clean, low-volume, editorially-curated collection of the
// most significant administrative-court decisions, published in periodic issues
// ("Vydání N/YYYY"). The current-issue page lists a handful of decisions, each
// with a stable URL carrying a monotonic id (.../<slug>.p<NNNN>.html). We scrape
// that page, enrich each decision from its detail page (headnote + statutes +
// legal thesis), keyword-filter, and hand the pipeline the same Item shape the
// RSS sources produce. The pipeline seen-store dedupes across runs (id = pNNNN),
// so each decision surfaces exactly once.
//
// Relevance is Tier B: NSS is administrative law, so its overlap with the
// insolvency/restructuring specialization is secondary — mainly tax and other
// public-law claims asserted within insolvency proceedings. The keyword filter
// runs against the headnote + the cited statutes ("předpisy") + the legal
// thesis, not just the slug, so decisions that reference the insolvenční zákon
// (č. 182/2006 Sb.) or insolvency proceedings are caught even when the short
// title does not spell out "insolvence".

const { BROWSER_UA } = require('./rss-generic');
const { withRetry } = require('../lib/retry');

const BASE = 'https://sbirka.nssoud.cz';
const CURRENT_ISSUE_URL = `${BASE}/cz/aktualni-vydani`;

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

// Parse decision links from an issue/listing page. Links look like
// /cz/<slug>.p<NNNN>.html (optionally with a ?q= suffix). Returns one entry per
// decision id, deduped, in first-seen order.
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

// Extract the issue label ("Vydání 6/2026") from the current-issue page title.
function parseIssueLabel(html) {
  const m = html.match(/<title>\s*([^<|]+?)\s*(?:\||<\/title>)/i);
  return m ? m[1].trim() : null;
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
async function fetchItems({ keywords = [], sourceId, sourceName, maxDetailFetches = 25 } = {}) {
  const issueHtml = await fetchHtml(CURRENT_ISSUE_URL);
  const issueLabel = parseIssueLabel(issueHtml);
  const links = parseDecisionLinks(issueHtml);
  if (links.length === 0) {
    // Layout changed — fail loudly so the monitor flags it rather than silently
    // reporting zero new NSS decisions forever.
    throw new Error('no decision links found on aktualni-vydani (layout change?)');
  }

  const items = [];
  for (const link of links.slice(0, maxDetailFetches)) {
    let detail;
    try {
      detail = parseDecisionDetail(await fetchHtml(link.url));
    } catch (err) {
      // One unreachable detail page must not sink the whole source; fall back to
      // a slug-derived title so the decision can still surface if it matches.
      const slug = link.url.split('/').pop().replace(/\.p\d+\.html.*$/, '');
      detail = { title: slug.replace(/-/g, ' '), text: '' };
    }
    const haystack = `${detail.title} ${detail.text}`;
    if (!matchesKeywords(haystack, keywords)) continue;

    const summary = detail.text.length > 600 ? detail.text.slice(0, 597) + '...' : detail.text;
    items.push({
      id: `nss-sbirka-p${link.pid}`,
      title: detail.title || `NSS rozhodnutí p${link.pid}`,
      url: link.url,
      // NSS detail pages carry no reliable machine-readable publish date; the
      // issue label is the best available temporal anchor. seen-store dedup makes
      // an exact pubDate non-essential here.
      pubDate: issueLabel ? `Sbírka NSS — ${issueLabel}` : null,
      summary: summary || detail.title,
      sourceId,
      sourceName,
    });
  }
  return items;
}

module.exports = { fetchItems, parseDecisionLinks, parseDecisionDetail, parseIssueLabel, CURRENT_ISSUE_URL };
