// Generic RSS/Atom fetcher for sources that don't require specialized parsing.
// Handles:
// - UTF-8 and windows-1250 encodings (PSP uses windows-1250)
// - Keyword filtering (case-insensitive, substring match across title+description+content)
// - CDATA stripping, basic HTML stripping for display

const { fetchFeed, parseFeedItems } = require('../lib/fetchFeed');
const { withRetry } = require('../lib/retry');

function stripHtml(s) {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchFeedWithEncoding(url, encoding) {
  return withRetry(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'FirezardMonitor/0.1 (legal-digest pilot; contact: founder)' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
        if (!encoding || encoding === 'utf-8') return await res.text();
        // windows-1250: fetch as arraybuffer, decode with TextDecoder
        const buf = await res.arrayBuffer();
        return new TextDecoder(encoding).decode(buf);
      } finally {
        clearTimeout(timer);
      }
    },
    { label: `rss-generic ${url}` }
  );
}

function matchesKeywords(item, keywords) {
  if (!keywords || keywords.length === 0) return true;
  const haystack = [
    item.title,
    item.descriptionHtml,
    item.contentEncoded,
  ].join(' ').toLowerCase();
  return keywords.some((kw) => haystack.includes(kw.toLowerCase()));
}

function isWithinMaxAgeDays(pubDateStr, maxAgeDays) {
  if (!maxAgeDays || !pubDateStr) return true;
  const pub = new Date(pubDateStr);
  if (isNaN(pub.getTime())) return true;
  const cutoff = new Date(Date.now() - maxAgeDays * 86400 * 1000);
  return pub >= cutoff;
}

// Returns items as: { id, title, url, pubDate, summary, sourceId, sourceName }
// maxAgeDays: if set, drops items older than N days (important for archive-type feeds like Senát)
async function fetchItems({ feedUrl, keywords = [], encoding = 'utf-8', maxAgeDays, sourceId, sourceName }) {
  const xml = await fetchFeedWithEncoding(feedUrl, encoding);
  const parsed = parseFeedItems(xml);
  const relevant = parsed
    .filter((item) => isWithinMaxAgeDays(item.pubDate, maxAgeDays))
    .filter((item) => matchesKeywords(item, keywords));
  return relevant.map((item) => {
    const summary = stripHtml(item.descriptionHtml || item.contentEncoded || '');
    return {
      id: item.guid || item.link,
      title: stripHtml(item.title),
      url: item.link,
      pubDate: item.pubDate,
      summary: summary.length > 600 ? summary.slice(0, 597) + '...' : summary,
      sourceId,
      sourceName,
    };
  });
}

module.exports = { fetchItems };
