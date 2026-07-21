// Basic run monitoring (FIR-23 M4): append a record per pipeline run so we can
// answer "did this week's run succeed, how many sources returned data" without
// digging through console logs. Append-only JSON array, capped to last 100 runs.

const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '..', 'data', 'run_log.json');
const MAX_ENTRIES = 100;

function loadLog() {
  try {
    return JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function recordRun({ startedAt, sourceResults, itemCount, outPath, error }) {
  const log = loadLog();
  const okSources = sourceResults.filter((s) => s.ok).length;
  log.push({
    startedAt,
    finishedAt: new Date().toISOString(),
    status: error ? 'failed' : 'ok',
    error: error ? error.message : null,
    sourcesOk: okSources,
    sourcesTotal: sourceResults.length,
    sourceResults,
    itemCount: itemCount || 0,
    outPath: outPath || null,
  });
  const trimmed = log.slice(-MAX_ENTRIES);
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.writeFileSync(LOG_PATH, JSON.stringify(trimmed, null, 2), 'utf8');
  return trimmed[trimmed.length - 1];
}

function lastRun() {
  const log = loadLog();
  return log[log.length - 1] || null;
}

module.exports = { recordRun, lastRun };
