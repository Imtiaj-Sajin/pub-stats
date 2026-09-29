// Scans IOPscience "Track my article" manuscript IDs sequentially, starting
// from a given ID, incrementing the numeric suffix, until a run of
// consecutive "invalid ID" responses confirms the end of the assigned range.
//
// Usage:
//   node scan.js JNE-111663 [--delay=350] [--threshold=5] [--max=2000] [--out=results.json]
//
// Talks directly to the API the site's Angular app calls:
//   https://oh0l6sxf16.execute-api.eu-west-1.amazonaws.com/prod?articleId=<ID>
//   200 -> { stage, sub_stage, doi }
//   400 -> invalid / not-yet-assigned ID

const https = require('https');
const fs = require('fs');
const path = require('path');

const STAGE_MAP = JSON.parse(fs.readFileSync(path.join(__dirname, 'stages.map.json'), 'utf8'));
const stageTitle = (stage, subStage) => {
  const hit = STAGE_MAP.find(s => s.slug === `stage-${stage}-${subStage}`);
  return hit ? hit.title : `Unknown stage ${stage}.${subStage}`;
};
const REJECT_STAGES = new Set([7]); // Flat reject / Reject & transfer / Reject to resubmit

function parseArgs(argv) {
  const [startId, ...rest] = argv;
  const opts = { delay: 350, threshold: 5, max: 2000, out: null };
  for (const arg of rest) {
    const m = arg.match(/^--(\w+)=(.+)$/);
    if (m) opts[m[1]] = isNaN(Number(m[2])) ? m[2] : Number(m[2]);
  }
  return { startId, opts };
}

function splitId(id) {
  const m = id.trim().match(/^([A-Za-z]+)-(\d+)$/);
  if (!m) throw new Error(`Cannot parse manuscript ID: ${id}`);
  return { prefix: m[1].toUpperCase(), num: parseInt(m[2], 10), width: m[2].length };
}

function fetchStatus(articleId) {
  return new Promise((resolve) => {
    const url = `https://oh0l6sxf16.execute-api.eu-west-1.amazonaws.com/prod?articleId=${encodeURIComponent(articleId)}`;
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Origin': 'https://publishingsupport.iopscience.iop.org',
        'Referer': 'https://publishingsupport.iopscience.iop.org/track-my-article/',
        'Accept': 'application/json',
      },
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            resolve({ ok: true, status: res.statusCode, data });
          } catch (e) {
            resolve({ ok: false, status: res.statusCode, error: 'parse_error', raw: body });
          }
        } else {
          resolve({ ok: false, status: res.statusCode, raw: body });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, status: 0, error: e.message }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { startId, opts } = parseArgs(process.argv.slice(2));
  if (!startId) {
    console.error('Usage: node scan.js JNE-111663 [--delay=350] [--threshold=5] [--max=2000] [--out=results.json]');
    process.exit(1);
  }
  const { prefix, num: startNum, width } = splitId(startId);

  console.error(`Scanning ${prefix}-#### upward from ${startNum} (delay=${opts.delay}ms, stop after ${opts.threshold} consecutive invalid IDs)...`);

  const results = [];
  let invalidStreak = 0;
  let n = startNum;
  let checked = 0;

  while (checked < opts.max) {
    const id = `${prefix}-${String(n).padStart(width, '0')}`;
    const res = await fetchStatus(id);
    checked++;

    if (res.ok) {
      invalidStreak = 0;
      const { stage, sub_stage, doi } = res.data;
      const title = stageTitle(stage, sub_stage);
      const rejected = REJECT_STAGES.has(stage);
      results.push({ id, stage, sub_stage, title, rejected, doi: doi && doi !== 'null' ? doi : null });
      console.error(`${id}  ${rejected ? 'REJECTED' : 'valid'}  stage ${stage}.${sub_stage} - ${title}`);
    } else if (res.status === 400) {
      invalidStreak++;
      results.push({ id, invalid: true });
      console.error(`${id}  invalid (no such manuscript) [streak ${invalidStreak}/${opts.threshold}]`);
      if (invalidStreak >= opts.threshold) {
        console.error(`Reached ${opts.threshold} consecutive invalid IDs — stopping.`);
        break;
      }
    } else {
      results.push({ id, error: res.error || `http_${res.status}` });
      console.error(`${id}  ERROR (${res.error || res.status}) — treating as skip, not counted toward invalid streak`);
    }

    n++;
    await sleep(opts.delay);
  }

  const outPath = opts.out || `scan-${prefix}-${startNum}.json`;
  fs.writeFileSync(path.join(__dirname, outPath), JSON.stringify(results, null, 2));
  console.error(`\nDone. ${results.filter(r => r.stage !== undefined).length} valid IDs found, wrote ${outPath}`);
}

main();
