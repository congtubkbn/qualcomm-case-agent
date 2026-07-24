// scripts/run_case.mjs — the whole capture pipeline as ONE deterministic command.
//
//     node run_case.mjs <CODE> [--mode auto|full|update] [--enrich local|none] [--no-pdf]
//
// Why: PHASE 0 -> 5 driven turn-by-turn costs ~25 agent turns, most of them
// `snapshot` dumps of a Salesforce accessibility tree that exist only so the
// model can find one @ref to click. None of those decisions are judgement calls
// — they are "click every Expand Post until there are none left". Running them
// here spends zero model tokens and no shell quoting, and makes the same
// pipeline usable UNATTENDED (scheduler.mjs) where there is no model at all.
//
// stdout is exactly ONE JSON line (the verdict). Everything else goes to stderr.
//
// Verdict `status`:
//   created | updated | no-update   -> exit 0
//   auth-required                   -> exit 3  (human must finish Okta/OTP once)
//   not-found                       -> exit 4  (wrong code, or no access)
//   blocked                         -> exit 5  (page never rendered / capture short)
//   busy                            -> exit 6  (another capture holds the lock — retry later)
//   error                           -> exit 1
//
// "blocked" is never downgraded to "no-update": a tool failure means
// inconclusive, not "confirmed unchanged" (SKILL.md PHASE 1.5B hard rule).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DATA_DIR } from './_paths.mjs';
import { intake } from './intake.mjs';
import { acquireLock, releaseLock } from './lock.mjs';
import { BrowserError, ensureChrome, evalFile, open, pdf, sleep } from './browser.mjs';

const SCRIPTS = fileURLToPath(new URL('.', import.meta.url));
const PORTAL = 'https://support.qualcomm.com';
const READY_ROUNDS = 8;      // x 2s = 16s ceiling for SPA hydration
const EXPAND_ROUNDS = 40;    // pagination + expansion ticks

export const STATUS_EXIT = {
  created: 0, updated: 0, 'no-update': 0,
  'auth-required': 3, 'not-found': 4, blocked: 5, busy: 6, error: 1,
};

const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
const page = name => join(SCRIPTS, name);

/** Anchor = the newest CACHED comment; PHASE 1.5B stops paginating there. */
export function anchorOf(cached) {
  const c = cached && Array.isArray(cached.comments) && cached.comments[0];
  return c ? { author: c.author, bodyStart: norm(c.body).slice(0, 80) } : null;
}

/** Unchanged iff the feed total AND the top post both still match the cache. */
export function isNoUpdate(probe, cached) {
  if (!cached || !probe || !probe.top) return false;
  if (probe.anchorIdx !== 0) return false;
  const displayedSame = probe.displayed == null || probe.displayed === cached.displayedCommentCount;
  return displayedSame;
}

function node(script, args) {
  const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    encoding: 'utf8', timeout: 300000,
  });
  const out = (r.stdout || '').trim();
  let json = null;
  try { json = JSON.parse(out.split('\n').filter(Boolean).pop() || 'null'); } catch { /* text output */ }
  return { code: r.status, out, json, err: (r.stderr || '').trim() };
}

async function pollReadiness() {
  let probe = null;
  for (let i = 0; i < READY_ROUNDS; i++) {
    probe = evalFile(page('readiness.js'));
    if (probe && probe.state && probe.state !== 'LOADING') return probe;
    await sleep(2000);
  }
  return probe || { state: 'BLANK' };
}

async function run(code, opts) {
  const caseDir = join(DATA_DIR, code);
  const casePath = join(caseDir, 'case.json');
  const cached = existsSync(casePath) ? JSON.parse(readFileSync(casePath, 'utf8')) : null;
  const mode = opts.mode === 'auto' ? (cached ? 'update' : 'full') : opts.mode;
  const merge = mode === 'update' && !!cached;
  const anchor = merge ? anchorOf(cached) : null;

  await ensureChrome();

  // --- PHASE 1: straight to global search. A valid code needs no confirmation.
  open(`${PORTAL}/s/global-search/${code}`);
  let ready = await pollReadiness();

  if (ready.state === 'BLANK' || ready.state === 'LOADING') {
    open(`${PORTAL}/s/global-search/${code}`);          // Recovery 2, same URL, once
    ready = await pollReadiness();
  }
  if (ready.state === 'AUTH') {
    return { status: 'auth-required', reason: 'Okta session lapsed — sign in once in the persistent Chrome profile (email OTP is human-only)', url: ready.url };
  }
  if (ready.state === 'EMPTY') {
    return { status: 'not-found', reason: `no search result for ${code} (wrong code, or the account cannot see it)` };
  }
  if (ready.state !== 'READY') {
    return { status: 'blocked', reason: `search page never rendered (state=${ready.state})`, probe: ready };
  }

  // --- PHASE 1 cont.: resolve the case URL browser-side (no snapshot needed).
  const link = evalFile(page('find_case_link.js'), { __CODE: code });
  if (!link || link.state === 'NO_LINK') {
    return { status: 'not-found', reason: `search rendered but exposed no case link for ${code}` };
  }
  const header = link.fields || {};
  if (link.state === 'FOUND') {
    open(link.href);
    const after = await pollReadiness();
    if (after.state === 'AUTH') {
      return { status: 'auth-required', reason: 'session lapsed while opening the case', url: after.url };
    }
  }

  // --- PHASE 1.5: probe first (fast no-update check), then expand in-page.
  let probe = evalFile(page('expand_step.js'), { __ANCHOR: anchor, __PROBE: true });
  for (let i = 0; i < READY_ROUNDS && (!probe || !probe.articles); i++) {
    await sleep(2000);
    probe = evalFile(page('expand_step.js'), { __ANCHOR: anchor, __PROBE: true });
  }
  if (!probe || !probe.articles) {
    return { status: 'blocked', reason: 'case page has no Chatter feed articles — wrong page or feed never loaded', probe };
  }
  if (merge && isNoUpdate(probe, cached)) {
    return {
      status: 'no-update', since: cached.extractedAt,
      commentCount: cached.comments.length, displayed: probe.displayed,
    };
  }

  let rounds = 0;
  for (; rounds < EXPAND_ROUNDS; rounds++) {
    const r = evalFile(page('expand_step.js'), { __ANCHOR: anchor });
    if (!r.clickedExpand && !r.clickedViewMore && !r.clickedDescription) break;
    await sleep(r.clickedViewMore ? 2000 : 800);
  }

  // --- PHASE 2: extract from the DOM exactly as expansion left it.
  const raw = evalFile(page('extract_case.js'));
  if (!raw || !Array.isArray(raw.comments)) {
    return { status: 'blocked', reason: 'extractor returned no comments array', raw: typeof raw };
  }
  const rawPath = join(caseDir, 'case.raw.json');
  writeFileSync(rawPath, JSON.stringify(raw), 'utf8');   // Node writes UTF-8, never a BOM

  const flags = [];
  // On a merge the fresh row is the current truth for status/priority, but the
  // cached title (curated, full) beats a truncated results-cell — leave it be.
  if (!merge && header.title) flags.push('--title', header.title);
  if (header.status) flags.push('--status', header.status);
  if (header.priority) flags.push('--priority', header.priority);
  if (header.customer) flags.push('--customer', header.customer);

  const oldHash = cached ? cached.hash : null;
  const fin = node('scrape_case.mjs', [code, rawPath, ...(merge ? ['--merge'] : []), ...flags]);
  const v = fin.json || {};
  if (fin.code === 5) return { status: 'blocked', reason: v.reason || 'incomplete capture', finalize: v, expandRounds: rounds };
  if (fin.code !== 0) return { status: 'error', reason: v.reason || fin.err || `scrape_case exited ${fin.code}`, finalize: v };

  const newComments = merge ? (v.newComments ?? 0) : v.commentCount;
  const changed = merge
    ? Boolean(v.changed || v.headerChanged)
    : Boolean(!oldHash || oldHash !== v.hash);

  if (!changed) {
    return { status: 'no-update', since: cached?.extractedAt, commentCount: v.commentCount, hash: v.hash };
  }

  // --- PHASE 3 (optional, local model) + PHASE 4: persist + render.
  const artifacts = {};
  if (opts.enrich === 'local') {
    const e = node('enrich_local.mjs', [code, ...(merge ? [] : ['--all'])]);
    artifacts.enrich = e.json || { ok: false, reason: e.err.slice(0, 200) };
  }
  const rend = node('render_case.mjs', [casePath]);
  if (rend.code !== 0) artifacts.renderError = rend.err.slice(0, 200);

  if (!opts.noPdf) {
    const pdfPath = join(caseDir, 'case.pdf');
    try {
      open(pathToFileURL(join(caseDir, 'case.html')).href);
      pdf(pdfPath);
      // Non-zero size, not mere existence — a failed print leaves a 0-byte file.
      artifacts.pdf = existsSync(pdfPath) && statSync(pdfPath).size > 0;
    } catch (e) { artifacts.pdf = false; artifacts.pdfError = e.message; }
  }

  return {
    status: cached ? 'updated' : 'created',
    commentCount: v.commentCount,
    newComments,
    newCommentIds: v.newCommentIds,
    hash: v.hash,
    title: header.title || undefined,
    dir: caseDir,
    expandRounds: rounds,
    ...artifacts,
  };
}

function parseArgs(argv) {
  const opts = { mode: 'auto', enrich: 'none', noPdf: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mode') opts.mode = argv[++i];
    else if (argv[i] === '--enrich') opts.enrich = argv[++i];
    else if (argv[i] === '--no-pdf') opts.noPdf = true;
  }
  return opts;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const started = Date.now();
  let code = null;
  try {
    code = intake(process.argv[2]);
  } catch (e) {
    process.stdout.write(JSON.stringify({ code: process.argv[2] ?? null, status: 'error', reason: e.message }) + '\n');
    process.exit(1);
  }
  const opts = parseArgs(process.argv.slice(3));
  if (!['auto', 'full', 'update'].includes(opts.mode)) {
    process.stdout.write(JSON.stringify({ code, status: 'error', reason: `bad --mode ${opts.mode}` }) + '\n');
    process.exit(1);
  }

  // One capture at a time: every path (interactive, sweep, dashboard Sync now)
  // drives the same Chrome — a second run reports `busy` instead of colliding.
  const lock = acquireLock();
  if (!lock.ok) {
    process.stdout.write(JSON.stringify({
      code, status: 'busy',
      reason: `another capture is running (pid ${lock.holder.pid} since ${lock.holder.at})`,
    }) + '\n');
    process.exit(STATUS_EXIT.busy);
  }

  run(code, opts)
    .catch(e => ({
      status: e instanceof BrowserError ? 'blocked' : 'error',
      reason: e.message,
      detail: e.detail,
    }))
    .then(v => {
      releaseLock();
      const verdict = { code, ...v, elapsedMs: Date.now() - started };
      process.stdout.write(JSON.stringify(verdict) + '\n');
      process.exit(STATUS_EXIT[verdict.status] ?? 1);
    });
}
