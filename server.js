// Local web interface for the manuscript tracker.
// Run with: node server.js   (then open http://localhost:5175)
//
// Every scan is streamed to the browser live (Server-Sent Events) and,
// once finished, appended to data/runs.json with a timestamp so past
// runs can be browsed later.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 5175;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const RUNS_FILE = path.join(DATA_DIR, 'runs.json');
const DOI_DATES_FILE = path.join(DATA_DIR, 'doi-dates.json');
const API = 'https://oh0l6sxf16.execute-api.eu-west-1.amazonaws.com/prod?articleId=';

const STAGE_MAP = JSON.parse(fs.readFileSync(path.join(ROOT, 'stages.map.json'), 'utf8'));
function stageTitle(s, ss) {
  const hit = STAGE_MAP.find((x) => x.slug === `stage-${s}-${ss}`);
  return hit ? hit.title : `Stage ${s}.${ss}`;
}

function loadRuns() {
  try {
    return JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveRun(run) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const runs = loadRuns();
  runs.push(run);
  fs.writeFileSync(RUNS_FILE, JSON.stringify(runs, null, 2));
}

function fetchStatus(articleId) {
  return new Promise((resolve) => {
    const req = https.get(API + encodeURIComponent(articleId), {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/json',
        Origin: 'https://publishingsupport.iopscience.iop.org',
        Referer: 'https://publishingsupport.iopscience.iop.org/track-my-article/',
      },
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve({ ok: true, data: JSON.parse(body) }); }
          catch { resolve({ ok: false, error: 'parse_error' }); }
        } else if (res.statusCode === 400) {
          resolve({ ok: false, invalid: true });
        } else {
          resolve({ ok: false, error: `http_${res.statusCode}` });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REVISION_STAGE = 3;

// When a manuscript is asked to revise, its BASE id freezes at stage 3
// ("Revision") forever, and the real progress continues under a new id with a
// ".rN" suffix (.r1 for the first revision, .r2 for the second, and so on).
// So a base showing "Revision" is almost always stale. This follows the chain:
// while the current node is at stage 3, probe the next ".rN"; keep the furthest
// one that exists. Stops when the next ".rN" is missing (genuinely still
// awaiting the author's revision) or the current node has moved past revision.
async function resolveRevisionChain(baseId, baseData, revDelayMs) {
  let data = baseData, rev = 0;
  while (data && data.stage === REVISION_STAGE && rev < 20) {
    if (revDelayMs) await sleep(revDelayMs);
    const cand = await fetchStatus(baseId + '.r' + (rev + 1));
    if (!cand.ok) break; // 400 = not resubmitted yet; error = leave as-is
    rev += 1;
    data = cand.data;
  }
  return { data: data, rev: rev };
}

// DOI -> {received, accepted, published} date cache. These never change once
// set, so they're persisted to disk and never re-fetched once resolved.
function loadDoiCache() {
  try { return JSON.parse(fs.readFileSync(DOI_DATES_FILE, 'utf8')); }
  catch (e) { return {}; }
}
function saveDoiCache(cache) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DOI_DATES_FILE, JSON.stringify(cache, null, 2));
}

function assertionDate(assertions, name) {
  const hit = (assertions || []).find((a) => a.name === name);
  return hit ? hit.value : null;
}

function fetchCrossrefDates(doi) {
  return new Promise((resolve) => {
    const req = https.get(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      headers: { 'User-Agent': 'pub-stats-tracker (mailto:local@localhost)', Accept: 'application/json' },
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve({ error: `http_${res.statusCode}` }); return; }
        try {
          const msg = JSON.parse(body).message;
          const assertions = msg.assertion;
          const online = msg['published-online'] && msg['published-online']['date-parts'] && msg['published-online']['date-parts'][0];
          const print = msg['published-print'] && msg['published-print']['date-parts'] && msg['published-print']['date-parts'][0];
          resolve({
            received: assertionDate(assertions, 'date_received'),
            accepted: assertionDate(assertions, 'date_accepted'),
            published: assertionDate(assertions, 'date_epub') || (online ? online.join('-') : null) || (print ? print.join('-') : null),
          });
        } catch (e) {
          resolve({ error: 'parse_error' });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', (e) => resolve({ error: e.message }));
  });
}

function parseManuscriptId(raw) {
  const m = String(raw || '').trim().toUpperCase().match(/^([A-Z]+)-(\d+)$/);
  if (!m) return null;
  return { prefix: m[1], num: parseInt(m[2], 10), width: m[2].length };
}

function sseSend(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handleScanStream(req, res, query) {
  const parsed = parseManuscriptId(query.get('startId'));
  if (!parsed) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_start_id' }));
    return;
  }
  const delayMs = Math.max(100, parseInt(query.get('delay'), 10) || 300);
  const threshold = Math.max(2, parseInt(query.get('threshold'), 10) || 6);
  const maxChecks = Math.max(10, parseInt(query.get('max'), 10) || 1500);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  let stopped = false;
  req.on('close', () => { stopped = true; });

  const records = [];
  const gaps = [];
  let invalidStreak = 0;
  let n = parsed.num;
  let checked = 0;
  const startedAt = new Date().toISOString();

  while (checked < maxChecks && !stopped) {
    const id = `${parsed.prefix}-${String(n).padStart(parsed.width, '0')}`;
    const result = await fetchStatus(id);
    checked++;

    if (result.ok) {
      invalidStreak = 0;
      let data = result.data, rev = 0;
      if (data.stage === REVISION_STAGE) {
        const resolved = await resolveRevisionChain(id, data, Math.min(delayMs, 200));
        data = resolved.data;
        rev = resolved.rev;
      }
      const rec = { id, s: data.stage, ss: data.sub_stage };
      if (data.doi && data.doi !== 'null') rec.doi = data.doi;
      if (rev > 0) rec.rev = rev;
      records.push(rec);
      const via = rev > 0 ? `  (via .r${rev})` : '';
      sseSend(res, 'log', { text: `${id}  ${stageTitle(rec.s, rec.ss)}${via}`, kind: rec.s === 7 ? 'r' : 'g' });
    } else if (result.invalid) {
      invalidStreak++;
      gaps.push(id);
      sseSend(res, 'log', { text: `${id}  invalid [${invalidStreak}/${threshold}]`, kind: 'x' });
      if (invalidStreak >= threshold) {
        sseSend(res, 'log', { text: `Confirmed end of range after ${threshold} consecutive invalid IDs.`, kind: 'x' });
        n++;
        break;
      }
    } else {
      sseSend(res, 'log', { text: `${id}  error (${result.error}) — skipped`, kind: 'x' });
    }

    n++;
    sseSend(res, 'progress', { checked, current: id });
    if (invalidStreak >= threshold) break;
    await sleep(delayMs);
  }

  const midGaps = invalidStreak >= threshold ? gaps.slice(0, gaps.length - invalidStreak) : gaps;
  records.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  const run = {
    id: `run_${Date.now()}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    prefix: parsed.prefix,
    startNum: parsed.num,
    width: parsed.width,
    delayMs,
    threshold,
    totalChecked: checked,
    stopped,
    records,
    gaps: midGaps,
  };

  if (records.length || !stopped) saveRun(run);

  sseSend(res, 'done', run);
  if (!res.writableEnded) res.end();
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && reqUrl.pathname === '/') {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'));
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/runs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadRuns()));
    return;
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/scan/stream') {
    handleScanStream(req, res, reqUrl.searchParams).catch((e) => {
      try { sseSend(res, 'error', { message: e.message }); res.end(); } catch {}
    });
    return;
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/doi-dates') {
    const doi = reqUrl.searchParams.get('doi');
    if (!doi) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'missing_doi' })); return; }
    const cache = loadDoiCache();
    if (cache[doi]) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cache[doi]));
      return;
    }
    fetchCrossrefDates(doi).then((dates) => {
      if (!dates.error) { cache[doi] = dates; saveDoiCache(cache); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dates));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Manuscript tracker running at http://localhost:${PORT}`);
});
