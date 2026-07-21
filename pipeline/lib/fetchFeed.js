// Minimal WordPress RSS fetcher/parser — zero dependencies.
// Works for sbirka.nsoud.cz/feed/ and is generic enough for other WP-based
// Tier A sources later (regex-based, not a full XML parser, so keep inputs
// to well-formed WordPress RSS feeds).

const { withRetry } = require('./retry');

async function fetchFeed(url, { timeoutMs = 20000 } = {}) {
  return withRetry(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'FirezardMonitor/0.1 (legal-digest pilot; contact: founder)' },
        });
        if (!res.ok) throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
        return await res.text();
      } finally {
        clearTimeout(timer);
      }
    },
    { label: `fetchFeed ${url}` }
  );
}

function stripCdata(s) {
  if (s == null) return '';
  const m = s.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return m ? m[1] : s;
}

function tag(block, name) {
  const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i');
  const m = block.match(re);
  return m ? stripCdata(m[1].trim()) : '';
}

// Parses a WordPress RSS feed body into an array of
// { title, link, guid, pubDate, contentEncoded, descriptionHtml }.
function parseFeedItems(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const block of itemBlocks) {
    items.push({
      title: tag(block, 'title'),
      link: tag(block, 'link'),
      guid: tag(block, 'guid'),
      pubDate: tag(block, 'pubDate'),
      contentEncoded: tag(block, 'content:encoded'),
      descriptionHtml: tag(block, 'description'),
    });
  }
  return items;
}

module.exports = { fetchFeed, parseFeedItems };
