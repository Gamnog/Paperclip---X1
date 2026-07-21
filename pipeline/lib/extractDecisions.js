// Parses a "sešit vydán" (issue-published) NS Sbírka RSS item's content:encoded
// HTML into individual decision records. Each decision in the sešit follows a
// fixed pattern in the source markup:
//
//   <p><strong>NN/YYYY</strong></p>
//   <p>headline text (sp. zn.|sen. zn. CASE_REF)</p>
//   <p>Právní věta:</p>
//   <p>legal sentence 1</p>
//   <p>legal sentence 2</p>  [optional, repeats]
//   <p>Více zde: <a href="URL">URL</a></p>
//
// Not every NS Sbírka post is a "sešit" announcement (e.g. index/redesign
// notices) — posts without this pattern simply yield zero decisions.

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

const CASE_REF_RE = /\((?:sp\.\s*zn\.|sen\.\s*zn\.)\s*([0-9]+\s*[A-Za-zÀ-ž]+\s*\d+\/\d+)\)/i;

function extractDecisions(contentEncodedHtml, { sourceUrl } = {}) {
  const paragraphs = (contentEncodedHtml.match(/<p[^>]*>[\s\S]*?<\/p>|<li[^>]*>[\s\S]*?<\/li>/g) || [])
    .map(stripTags)
    .filter(Boolean);

  const decisions = [];
  let i = 0;
  while (i < paragraphs.length) {
    const numberMatch = paragraphs[i].match(/^(\d+\/\d{4})$/);
    if (!numberMatch) {
      i++;
      continue;
    }
    const number = numberMatch[1];
    const headline = paragraphs[i + 1] || '';
    const caseRefMatch = headline.match(CASE_REF_RE);
    if (!caseRefMatch) {
      // Not a decision entry we can identify a case reference for — skip past it.
      i++;
      continue;
    }
    const caseRef = caseRefMatch[1].replace(/\s+/g, ' ').trim();

    let j = i + 2;
    let legalBasis = '';
    if (paragraphs[j] && /^Právní věta:?$/i.test(paragraphs[j])) {
      j++;
      const sentences = [];
      while (paragraphs[j] && !/^Více zde:/i.test(paragraphs[j])) {
        sentences.push(paragraphs[j]);
        j++;
      }
      legalBasis = sentences.join(' ');
    }

    let url = sourceUrl || '';
    if (paragraphs[j] && /^Více zde:/i.test(paragraphs[j])) {
      const urlMatch = paragraphs[j].match(/https?:\/\/\S+/);
      if (urlMatch) url = urlMatch[0];
      j++;
    }

    decisions.push({
      number,
      caseRef,
      headline: headline.replace(CASE_REF_RE, '').trim(),
      legalBasis,
      url,
    });
    i = j;
  }
  return decisions;
}

module.exports = { extractDecisions, CASE_REF_RE };
