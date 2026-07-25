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
import { BrowserError, click, ensureChrome, evalFile, open, pdf, sleep } from './browser.mjs';

const SCRIPTS = fileURLToPath(new URL('.', import.meta.url));
const PORTAL = 'https://support.qualcomm.com';
const READY_ROUNDS = 8;      // x 2s = 16s ceiling for SPA hydration
const FEED_PROBE_ROUNDS = 15; // x 2s = 30s ceiling — Chatter feed hydration is
                               // slower than page readiness right after a fresh
                               // login (cold Lightning component bootstrap)
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

// Lightning's un-routed case stub (`/s/case/Case/Default`). readiness.js's
// READY signal (lightning-base-formatted-text etc.) fires on this shell too,
// so a click that fails to route (element detached mid-CDP-click, timing miss)
// looks identical to a real landing unless we check the path explicitly.
export const STUB_PATH_RE = /\/s\/case\/Case\/Default(?:$|[/?#])/i;
const HREF_RESOLVE_ROUNDS = 5; // x600ms — Lightning fills in the row's real
                                // SFID href ASYNCHRONOUSLY after the row itself
                                // renders; reading `.href` too early returns the
                                // generic `.../Case/Default` stub regardless of
                                // how navigation is triggered afterward (this is
                                // the actual root cause — not the click type).
const ROUTE_SETTLE_ROUNDS = 6; // x1s = 6s ceiling for the delegated-router
                                // click fallback to swap the URL; widest right
                                // after a fresh Okta re-auth, cold SPA.

/** find_case_link.js right after READY can catch the results table a tick
 *  into its own render: only the first row's anchor exists yet, href still
 *  the generic stub, header cells empty (`fields: {}` — which then fails
 *  scrape_case.mjs's title gate downstream). Poll until the row carries a
 *  resolved href AND a title, or give up after HREF_RESOLVE_ROUNDS and
 *  return whatever it last had. */
export async function findCaseLink(code) {
  let link = evalFile(page('find_case_link.js'), { __CODE: code });
  for (let i = 0; i < HREF_RESOLVE_ROUNDS && link && link.state === 'FOUND'
       && (!link.fields?.title || STUB_PATH_RE.test(new URL(link.href).pathname)); i++) {
    await sleep(600);
    link = evalFile(page('find_case_link.js'), { __CODE: code });
  }
  return link;
}

/** Land on the real case page. Primary: wait for the row to hydrate
 *  (findCaseLink), then `open()` its resolved href directly — a plain HTTP
 *  navigation, immune to whatever makes the delegated-router click
 *  unreliable (observed in the wild: a CDP-trusted click, even a raw
 *  mouse-event sequence or a focus+Enter key activation, can silently no-op
 *  on this anchor with no console error). Fallback: the trusted click, for
 *  the rare case a direct nav still lands on the stub. One full retry from a
 *  fresh search load before giving up — same shape as PHASE 1's Recovery 2.
 *
 *  A hard `open()` can reset the Chatter feed component to a thinner default
 *  view than a soft SPA transition would — scrape_case.mjs's full-capture
 *  path unions fresh comments with the cache instead of replacing it, so
 *  that never loses data; it only means an update may need `--mode full`
 *  more than once to fully re-paginate a long thread. */
export async function landOnCase(code) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const link = await findCaseLink(code);
    if (link && link.href && !STUB_PATH_RE.test(new URL(link.href).pathname)) {
      open(link.href);
      const after = await pollReadiness();
      if (after.state === 'AUTH') return { state: 'AUTH', url: after.url };
      const onCase = evalFile(page('find_case_link.js'), { __CODE: code });
      if (onCase && onCase.state === 'ON_CASE'
          && !STUB_PATH_RE.test(new URL(onCase.href).pathname)) {
        return { state: 'OK', href: onCase.href };
      }
    }

    // Direct nav still on the stub — fall back to the delegated-router click.
    try {
      click("[data-cq-hit='1']");
    } catch (e) { if (attempt === 1) throw e; }

    for (let i = 0; i < ROUTE_SETTLE_ROUNDS; i++) {
      const after = evalFile(page('readiness.js'));
      if (after.state === 'AUTH') return { state: 'AUTH', url: after.url };
      const onCase = evalFile(page('find_case_link.js'), { __CODE: code });
      if (onCase && onCase.state === 'ON_CASE'
          && !STUB_PATH_RE.test(new URL(onCase.href).pathname)) {
        return { state: 'OK', href: onCase.href };
      }
      await sleep(1000);
    }

    if (attempt === 0) {
      open(`${PORTAL}/s/global-search/${code}`);
      const ready = await pollReadiness();
      if (ready.state === 'AUTH') return { state: 'AUTH', url: ready.url };
      if (ready.state !== 'READY') return { state: 'STUB', reason: `retry search state=${ready.state}` };
      const relink = await findCaseLink(code);
      if (!relink || relink.state !== 'FOUND') return { state: 'STUB', reason: 'retry search exposed no case link' };
    }
  }
  return { state: 'STUB', reason: 'case link navigation never routed past the Lightning stub page' };
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
  const link = await findCaseLink(code);
  if (!link || link.state === 'NO_LINK') {
    return { status: 'not-found', reason: `search rendered but exposed no case link for ${code}` };
  }
  const header = link.fields || {};
  if (link.state === 'FOUND') {
    // The row's href resolves to the real SFID asynchronously after render;
    // landOnCase() waits for that then navigates straight to it, falling
    // back to a trusted click only if it's still unresolved.
    const landed = await landOnCase(code);
    if (landed.state === 'AUTH') {
      return { status: 'auth-required', reason: 'session lapsed while opening the case', url: landed.url };
    }
    if (landed.state !== 'OK') {
      return { status: 'blocked', reason: landed.reason || 'case link click did not route to the real case page', probe: landed };
    }
  }

  // --- PHASE 1.5: probe first (fast no-update check), then expand in-page.
  // The Chatter feed lazy-loads articles one at a time on a cold Lightning
  // bootstrap: `articles` goes truthy (1) well before the rest arrive. Waiting
  // for merely non-zero races the feed and truncates the capture to whatever
  // loaded first — wait for the count to hold steady across two ticks instead.
  const probeFeed = async () => {
    let p = evalFile(page('expand_step.js'), { __ANCHOR: anchor, __PROBE: true });
    for (let i = 0; i < FEED_PROBE_ROUNDS; i++) {
      const prevArticles = p ? p.articles : 0;
      await sleep(2000);
      p = evalFile(page('expand_step.js'), { __ANCHOR: anchor, __PROBE: true });
      if (p && p.articles && p.articles === prevArticles) break;
    }
    return p;
  };

  let probe = await probeFeed();
  if (!probe || !probe.articles) {
    // Cold-login Chatter component can fail to bootstrap at all on the first
    // render even though the case page itself is READY. One same-URL reload
    // (Recovery 2 style) recovers this without escalating to `blocked`.
    const onCase = evalFile(page('find_case_link.js'), { __CODE: code });
    if (onCase && onCase.href) {
      open(onCase.href);
      const reloaded = await pollReadiness();
      if (reloaded.state === 'AUTH') {
        return { status: 'auth-required', reason: 'session lapsed on feed-reload retry', url: reloaded.url };
      }
      probe = await probeFeed();
    }
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

  // Pagination/expand controls (esp. "View More Posts") can mount a tick after
  // the feed's article count itself settles — the same hydration lag as the
  // search-row and case-link races above. Breaking on the FIRST idle tick can
  // stop before that control ever appears, silently truncating the capture
  // (observed: a 6-comment case extracted as 2). Require two consecutive idle
  // ticks before concluding there is nothing left to expand.
  let rounds = 0;
  let idleTicks = 0;
  for (; rounds < EXPAND_ROUNDS; rounds++) {
    const r = evalFile(page('expand_step.js'), { __ANCHOR: anchor });
    if (!r.clickedExpand && !r.clickedViewMore && !r.clickedDescription) {
      idleTicks++;
      if (idleTicks >= 2) break;
      await sleep(1000);
      continue;
    }
    idleTicks = 0;
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

  // The finalizer reports the genuinely new ids whenever a cache existed — on a
  // forced full re-capture too, so that path costs one analysis per NEW comment
  // instead of re-analyzing the whole thread. No cache at all => everything is new.
  const newComments = v.newComments ?? v.commentCount;
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
    ...(v.idCollisions ? { idCollisions: v.idCollisions } : {}),
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
