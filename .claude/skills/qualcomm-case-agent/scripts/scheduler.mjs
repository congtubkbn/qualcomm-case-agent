// scripts/scheduler.mjs — unattended, scheduled capture of the watched cases.
//
//     node scheduler.mjs --once          # one sweep, then exit (Task Scheduler / cron)
//     node scheduler.mjs                 # resident loop, checks every minute
//     node scheduler.mjs --case 08603854 # force one case now, ignoring its interval
//
// Config: data/watchlist.json   (created on first run, git-ignored — case codes
//                                are customer data, they do not belong in git)
// State:  data/runs.json        (last result per case; the web UI reads this)
//
// Auth is the one thing a schedule cannot do for you: the Okta email OTP is
// human-only. So when a run comes back `auth-required` the sweep STOPS and
// flags it — retrying on a lapsed session just burns attempts and hides the
// one fact the user needs to see on the dashboard.
//
// `blocked, retryable: true` (a stuck expand loop / short capture — see
// run_case.mjs) is the opposite: worth hammering again soon, not waiting out
// the full interval. Handled like `busy` below — lastRunAt is NOT stamped, so
// the case stays due next tick — but bounded by MAX_RETRYABLE_ATTEMPTS so a
// genuinely stuck case doesn't drive Chrome every minute forever.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, PROJECT_ROOT } from './_paths.mjs';

const SCRIPTS = fileURLToPath(new URL('.', import.meta.url));
export const WATCHLIST_PATH = join(PROJECT_ROOT, 'data', 'watchlist.json');
export const RUNS_PATH = join(PROJECT_ROOT, 'data', 'runs.json');

const MAX_RETRYABLE_ATTEMPTS = 5; // consecutive un-stamped retries before a
                                    // retryable blocked falls back to a normal
                                    // blocked (stamped, waits out the interval)

const DEFAULT_WATCHLIST = {
  intervalMinutes: 240,
  enrich: 'none',        // 'local' once an OpenAI-compatible server is running
  pdf: true,
  cases: [],
};

export function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

export function loadWatchlist() {
  if (!existsSync(WATCHLIST_PATH)) writeJson(WATCHLIST_PATH, DEFAULT_WATCHLIST);
  return { ...DEFAULT_WATCHLIST, ...readJson(WATCHLIST_PATH, DEFAULT_WATCHLIST) };
}

/** Cases whose own interval (or the global default) has elapsed. */
export function dueCases(watchlist, runs, now = Date.now()) {
  return (watchlist.cases || []).filter(c => {
    if (c.enabled === false) return false;
    const last = runs[c.code]?.lastRunAt ? Date.parse(runs[c.code].lastRunAt) : 0;
    const every = (c.intervalMinutes ?? watchlist.intervalMinutes) * 60000;
    return now - last >= every;
  });
}

/** Should this verdict keep the case "due" (skip stamping lastRunAt) instead
 *  of waiting out the normal interval? Only `retryable` verdicts, and only up
 *  to MAX_RETRYABLE_ATTEMPTS in a row — past that it reads as a persistent
 *  problem, not a passing glitch, so it falls back to the normal stamp+wait. */
export function retryDecision(verdict, priorRetries) {
  const retry = Boolean(verdict.retryable) && priorRetries < MAX_RETRYABLE_ATTEMPTS;
  return { retry, retryCount: retry ? priorRetries + 1 : 0 };
}

/** Run one case through the full pipeline. Returns the verdict object. */
export function runCase(code, watchlist) {
  const args = [join(SCRIPTS, 'run_case.mjs'), code, '--enrich', watchlist.enrich || 'none'];
  if (watchlist.pdf === false) args.push('--no-pdf');
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 900000 });
  const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
  try { return JSON.parse(line); } catch {
    return { code, status: 'error', reason: (r.stderr || line || 'no output').trim().slice(0, 300) };
  }
}

export function sweep({ only = null } = {}) {
  const watchlist = loadWatchlist();
  const targets = only
    ? [(watchlist.cases || []).find(c => c.code === only) || { code: only }]
    : dueCases(watchlist, readJson(RUNS_PATH, {}));

  const results = [];
  for (const c of targets) {
    const v = runCase(c.code, watchlist);
    results.push(v);
    // `busy` = another capture held the lock. Don't stamp lastRunAt (so the
    // case stays due and retries next tick) and don't overwrite the last real
    // verdict with a transient one.
    if (v.status === 'busy') continue;
    // Re-read before writing: a dashboard-spawned run may have written its own
    // verdict while this sweep was busy capturing — merge, don't clobber.
    const runs = readJson(RUNS_PATH, {});
    const { retry, retryCount } = retryDecision(v, runs[c.code]?.retryCount || 0);
    if (retry) {
      runs[c.code] = { ...runs[c.code], status: v.status, reason: v.reason, retryCount };
      writeJson(RUNS_PATH, runs);
      continue;
    }
    runs[c.code] = {
      lastRunAt: new Date().toISOString(),
      status: v.status,
      reason: v.reason,
      newComments: v.newComments,
      commentCount: v.commentCount,
      elapsedMs: v.elapsedMs,
      retryCount,
    };
    writeJson(RUNS_PATH, runs);
    if (v.status === 'auth-required') break;   // human must sign in; stop the sweep
  }

  const authRequired = results.some(v => v.status === 'auth-required');
  const runs = readJson(RUNS_PATH, {});
  runs._sweep = { at: new Date().toISOString(), ran: results.length, authRequired };
  writeJson(RUNS_PATH, runs);
  return { ran: results.length, authRequired, results };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const only = argv.includes('--case') ? argv[argv.indexOf('--case') + 1] : null;

  if (argv.includes('--once') || only) {
    const s = sweep({ only });
    process.stdout.write(JSON.stringify(s) + '\n');
    process.exit(s.authRequired ? 3 : 0);
  }

  const tick = () => {
    try {
      const s = sweep();
      if (s.ran) process.stderr.write(`[scheduler] ${new Date().toISOString()} ran ${s.ran}\n`);
    } catch (e) { process.stderr.write(`[scheduler] ${e.message}\n`); }
  };
  process.stderr.write(`[scheduler] watching ${WATCHLIST_PATH} (cache ${DATA_DIR})\n`);
  tick();
  setInterval(tick, 60000);
}
