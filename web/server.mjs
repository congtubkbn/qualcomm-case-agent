// web/server.mjs — local dashboard for the Qualcomm case cache. Zero deps.
//
//     node web/server.mjs [--port 8787] [--scheduler]
//
// Binds 127.0.0.1 only: the cache is Qualcomm NDA material and must never be
// reachable from the network. `--scheduler` runs the sweep loop in the same
// process, so one command gives you "cases refresh on a schedule and the page
// shows the result".
//
// Routes
//   GET  /                       dashboard
//   GET  /api/overview           one projection of every cached case + run state
//   GET  /api/case/<CODE>        full case.json
//   GET  /artifact/<CODE>/<file> case.html | case.pdf | case.md | case.txt | case.report.md
//   POST /api/watchlist          { action: add|remove|toggle|settings, ... }
//   POST /api/run/<CODE>         kick off a capture now (non-blocking)

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, PROJECT_ROOT } from '../.claude/skills/qualcomm-case-agent/scripts/_paths.mjs';
import {
  RUNS_PATH, WATCHLIST_PATH, loadWatchlist, readJson, writeJson,
} from '../.claude/skills/qualcomm-case-agent/scripts/scheduler.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCRIPTS = join(PROJECT_ROOT, '.claude', 'skills', 'qualcomm-case-agent', 'scripts');
const ARTIFACTS = new Set(['case.html', 'case.pdf', 'case.md', 'case.txt', 'case.report.md']);
const isCode = c => /^\d{8}$/.test(c || '');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/** Small, UI-shaped projection of one cached case — never the whole comment set. */
export function projectCase(code, caseJson, indexEntry, run) {
  const e = caseJson?.enrichment || {};
  return {
    code,
    title: caseJson?.title || '',
    status: caseJson?.status || '',
    priority: caseJson?.priority || '',
    customer: caseJson?.customer || '',
    url: caseJson?.url || '',
    commentCount: caseJson?.comments?.length ?? 0,
    displayedCommentCount: caseJson?.displayedCommentCount ?? null,
    syncedAt: indexEntry?.syncedAt || caseJson?.extractedAt || null,
    enrichedAt: e.enrichedAt || null,
    enrichedBy: e.enrichedBy || null,
    currentStatus: e.currentStatus || '',
    engineerSummary: e.engineerSummary || '',
    rootCause: e.rootCause || '',
    openQuestions: e.openQuestions || [],
    recommendedActions: e.recommendedActions || [],
    tags: e.tags || [],
    latestComment: caseJson?.comments?.[0]
      ? { author: caseJson.comments[0].author, timestamp: caseJson.comments[0].timestamp }
      : null,
    artifacts: [...ARTIFACTS].filter(f => existsSync(join(DATA_DIR, code, f))),
    run: run || null,
  };
}

function overview() {
  const index = readJson(join(DATA_DIR, '_index.json'), {});
  const runs = readJson(RUNS_PATH, {});
  const watchlist = loadWatchlist();
  const codes = new Set([
    ...Object.keys(index),
    ...(existsSync(DATA_DIR) ? readdirSync(DATA_DIR).filter(isCode) : []),
    ...(watchlist.cases || []).map(c => c.code),
  ]);

  const cases = [...codes].map(code => {
    const p = join(DATA_DIR, code, 'case.json');
    const json = existsSync(p) ? readJson(p, null) : null;
    return {
      ...projectCase(code, json, index[code], runs[code]),
      watched: (watchlist.cases || []).some(c => c.code === code && c.enabled !== false),
      cached: !!json,
    };
  }).sort((a, b) => String(b.syncedAt || '').localeCompare(String(a.syncedAt || '')));

  return { cases, watchlist, sweep: runs._sweep || null, generatedAt: new Date().toISOString() };
}

function mutateWatchlist(body) {
  const wl = loadWatchlist();
  wl.cases = wl.cases || [];
  const find = code => wl.cases.find(c => c.code === code);

  if (body.action === 'add') {
    if (!isCode(body.code)) throw new Error('case code must be 8 digits');
    if (!find(body.code)) wl.cases.push({ code: body.code, enabled: true, ...(body.intervalMinutes ? { intervalMinutes: body.intervalMinutes } : {}) });
  } else if (body.action === 'remove') {
    wl.cases = wl.cases.filter(c => c.code !== body.code);
  } else if (body.action === 'toggle') {
    const c = find(body.code);
    if (c) c.enabled = c.enabled === false;
    else if (isCode(body.code)) wl.cases.push({ code: body.code, enabled: true });
  } else if (body.action === 'settings') {
    if (body.intervalMinutes) wl.intervalMinutes = Number(body.intervalMinutes);
    if (body.enrich) wl.enrich = body.enrich;
    if (typeof body.pdf === 'boolean') wl.pdf = body.pdf;
  } else {
    throw new Error(`unknown action ${body.action}`);
  }
  writeJson(WATCHLIST_PATH, wl);
  return wl;
}

const send = (res, status, body, type = MIME['.json']) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

// The server binds 127.0.0.1, but a browser on this machine can still be made
// to send requests here by a malicious page (CSRF / DNS rebinding). Both are
// cut off by insisting the browser thinks it is talking to localhost.
const LOCAL_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/;
function isLocalRequest(req) {
  if (!LOCAL_HOST_RE.test(req.headers.host || '')) return false;   // DNS rebinding
  const origin = req.headers.origin;
  if (!origin) return true;                                        // same-origin nav, curl, fetch
  try { return LOCAL_HOST_RE.test(new URL(origin).host); } catch { return false; }
}

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    try {
      if (!isLocalRequest(req)) return send(res, 403, { error: 'local requests only' });
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        return send(res, 200, readFileSync(join(HERE, 'app.html')), MIME['.html']);
      }
      if (req.method === 'GET' && path === '/api/overview') return send(res, 200, overview());

      let m = path.match(/^\/api\/case\/(\d{8})$/);
      if (req.method === 'GET' && m) {
        const p = join(DATA_DIR, m[1], 'case.json');
        return existsSync(p)
          ? send(res, 200, readFileSync(p), MIME['.json'])
          : send(res, 404, { error: 'not cached' });
      }

      m = path.match(/^\/artifact\/(\d{8})\/([\w.]+)$/);
      if (req.method === 'GET' && m && ARTIFACTS.has(m[2])) {
        const p = join(DATA_DIR, m[1], m[2]);
        if (!existsSync(p) || !statSync(p).isFile()) return send(res, 404, { error: 'no artifact' });
        return send(res, 200, readFileSync(p), MIME[extname(p)] || 'application/octet-stream');
      }

      if (req.method === 'POST' && path === '/api/watchlist') {
        return send(res, 200, mutateWatchlist(await readBody(req)));
      }

      m = path.match(/^\/api\/run\/(\d{8})$/);
      if (req.method === 'POST' && m) {
        // Detached so an agent-CLI run never blocks the dashboard; cli_run.mjs
        // writes its own runs.json entry, which /api/overview already surfaces.
        spawn(process.execPath, [join(HERE, 'cli_run.mjs'), m[1]], {
          detached: true, stdio: 'ignore',
        }).unref();
        return send(res, 202, { started: m[1] });
      }

      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const port = Number(argv.includes('--port') ? argv[argv.indexOf('--port') + 1] : 8787);
  createApp().listen(port, '127.0.0.1', () => {
    process.stderr.write(`[web] http://127.0.0.1:${port}  (cache ${DATA_DIR})\n`);
  });
  if (argv.includes('--scheduler')) {
    // Sweep in a CHILD process, never in-process: runCase blocks for up to
    // 15 min per case, which would freeze this event loop (and the dashboard)
    // for the whole capture. One child at a time — no overlapping sweeps.
    let child = null;
    const tick = () => {
      if (child) return;
      child = spawn(process.execPath, [join(SCRIPTS, 'scheduler.mjs'), '--once'], {
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      child.on('exit', () => { child = null; });
      child.on('error', e => { process.stderr.write(`[scheduler] ${e.message}\n`); child = null; });
    };
    tick();
    setInterval(tick, 60000);
  }
}
