// scripts/run_case.mjs — the whole capture pipeline as ONE deterministic command.
//
//     node run_case.mjs <CODE> [--mode auto|full|update]
//
// Why: Capturing a case involves authentication check, fast landing/search,
// expanding all Chatter feed posts, extracting DOM, sorting chronologically,
// and writing case.json and case.md. Running it as one command uses zero
// model tokens during extraction.
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
// inconclusive, not "confirmed unchanged" (SKILL.md hard rule).
//
// `retryable: true` on a `blocked` verdict marks a transient capture glitch
// (e.g. a stuck expand loop) worth retrying.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './_paths.mjs';
import { intake } from './intake.mjs';
import { acquireLockOrWaitForSameCode, releaseLock } from './lock.mjs';
import { BrowserError, ensureChrome, evalFile, evalFileViaCdp, getCdpClient, open, screenshot, sleep } from './browser.mjs';
import { fastLandOnCase } from './fast_landing.mjs';
import { verifyCase } from './verify_case.mjs';

const SCRIPTS = fileURLToPath(new URL('.', import.meta.url));
const PORTAL = 'https://support.qualcomm.com';
const FEED_PROBE_ROUNDS = 15; // x 2s = 30s ceiling — Chatter feed hydration is
                               // slower than page readiness right after a fresh
                               // login (cold Lightning component bootstrap)
const EXPAND_ROUNDS = 40;    // pagination + expansion ticks
const STUCK_RETRY_ROUNDS = 5; // x2s extra grace once the round budget runs out
                               // while still clicking "Expand Post" every tick
const SETTLE_ROUNDS = 8;      // x1s ceiling (incl. 2 mandatory confirm reads)
const POST_EXPAND_SETTLE_ROUNDS = 15; // x2s ceiling — see article-count settle note below
                               // for any post still showing "Expand Post" to
                               // get a real click and settle before extraction

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

/**
 * Standardize single-line verdict output object.
 */
export function formatVerdict(code, v = {}, started) {
  const elapsedMs = typeof started === 'number' ? Date.now() - started : (v.elapsedMs || 0);
  const landingMs = v.timing?.landingMs ?? v.durationMs ?? 0;
  const timing = {
    elapsedMs,
    landingMs,
    ...(v.timing || {}),
  };
  const status = v.status || 'error';
  const caseUrl = v.caseUrl || v.url || v.href || undefined;
  return {
    ...v,
    code,
    status,
    caseUrl,
    timing,
  };
}

/**
 * Unchanged iff the newest cached comment is still the top post AND nothing on
 * the feed is still hiding content.
 *
 * The probe tick clicks nothing, so any surviving "Expand Post" / "More
 * comments" control is content this check has not read — and a new nested reply
 * lives behind exactly such a control, under an OLD post, without moving the top
 * post (case 08503838, a reply that no update run could ever see). Unread
 * content makes the answer inconclusive, not "unchanged", so fall through to a
 * real expand + merge pass, which is the definitive comparison.
 *
 * `displayedCommentCount` is deliberately NOT consulted: the portal counter it
 * comes from drifts between reads of an identical thread (see extract_case.js),
 * so it can neither confirm nor deny a change.
 */
export function isNoUpdate(probe, cached) {
  if (!cached || !probe || !probe.top) return false;
  if (probe.anchorIdx !== 0) return false;
  // A probe from before these counters existed proves nothing either way.
  if (typeof probe.pendingExpand !== 'number' || typeof probe.pendingMoreComments !== 'number') return false;
  return probe.pendingExpand === 0 && probe.pendingMoreComments === 0;
}

/** Best-effort page screenshot. Evidence is worth having, never worth failing a
 *  good capture for, so a screenshot error degrades to `null` (verify_case.mjs
 *  reports the missing file as a warning, not an error). */
function shoot(dir, name) {
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    screenshot(join(dir, name));
    return name;
  } catch (e) {
    process.stderr.write(`screenshot failed (${name}): ${e.message}\n`);
    return null;
  }
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

export async function run(code, opts = {}) {
  const caseDir = join(DATA_DIR, code);
  const casePath = join(caseDir, 'case.json');
  // Strip a possible leading BOM (e.g. a cache hand-edited on Windows) — same
  // defensive read as scrape_case.mjs and render_case.mjs do for this same file.
  let cached = null;
  if (existsSync(casePath)) {
    const t = readFileSync(casePath, 'utf8');
    cached = JSON.parse(t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t);
  }
  const mode = opts.mode === 'auto' ? (cached ? 'update' : 'full') : opts.mode;
  const merge = mode === 'update' && !!cached;
  const anchor = merge ? anchorOf(cached) : null;

  await ensureChrome();

  let cdp = opts.cdp || null;
  if (!cdp) {
    try {
      cdp = await getCdpClient();
    } catch (e) {
      process.stderr.write(`[CDP] Direct connection failed: ${e.message}\n`);
    }
  }

  if (!cdp || (typeof cdp.isConnected === 'function' && !cdp.isConnected())) {
    return {
      status: 'blocked',
      reason: 'CDP client connection unavailable on port 9222 (check Chrome instance)',
    };
  }

  const landed = await fastLandOnCase(code, {
    cdp,
    cached,
    portalUrl: PORTAL,
  });
  const landingDurationMs = landed.durationMs || 0;
  const diagnostics = landed.diagnostics || [];

  if (landed.state === 'AUTH') {
    const shot = shoot(caseDir, 'auth_required.png');
    return {
      status: 'auth-required',
      reason: landed.reason || 'Okta session lapsed — sign in once in the persistent Chrome profile (email OTP is human-only)',
      url: landed.url,
      caseUrl: landed.url,
      timing: { landingMs: landingDurationMs },
      diagnostics,
      screenshot: shot,
    };
  }
  if (landed.state === 'NOT_FOUND') {
    const shot = shoot(caseDir, 'not_found.png');
    return {
      status: 'not-found',
      reason: landed.reason || `no search result for ${code} (wrong code, or the account cannot see it)`,
      timing: { landingMs: landingDurationMs },
      diagnostics,
      screenshot: shot,
    };
  }
  if (landed.state === 'STUB') {
    const shot = shoot(caseDir, 'landing_failure.png');
    return {
      status: 'blocked',
      reason: landed.reason || 'case link click did not route to the real case page',
      probe: landed,
      timing: { landingMs: landingDurationMs },
      diagnostics,
      screenshot: shot,
    };
  }
  if (landed.state !== 'OK') {
    const shot = shoot(caseDir, 'landing_failure.png');
    return {
      status: 'blocked',
      reason: landed.reason || `search/landing failed (state=${landed.state})`,
      probe: landed,
      timing: { landingMs: landingDurationMs },
      diagnostics,
      screenshot: shot,
    };
  }
  const caseUrl = landed.href;
  const header = landed.fields || {};

  // --- PHASE 1.5: probe first (fast no-update check), then expand in-page.
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
    if (caseUrl) {
      if (typeof cdp.navigate === 'function') {
        await cdp.navigate(caseUrl);
      } else {
        open(caseUrl);
      }
      probe = await probeFeed();
    }
  }
  if (!probe || !probe.articles) {
    const shot = shoot(caseDir, 'feed_missing.png');
    return {
      status: 'blocked',
      reason: 'case page has no Chatter feed articles — wrong page or feed never loaded',
      probe,
      caseUrl,
      timing: { landingMs: landingDurationMs },
      diagnostics,
      screenshot: shot,
    };
  }
  if (merge && isNoUpdate(probe, cached)) {
    const shot = shoot(caseDir, 'probe.png');
    return {
      status: 'no-update', since: cached.extractedAt,
      commentCount: cached.comments.length,
      caseUrl: caseUrl || cached.caseUrl || cached.url,
      timing: { landingMs: landingDurationMs },
      diagnostics,
      evidence: { articles: probe.articles, pendingExpand: 0, pendingMoreComments: 0, screenshot: shot },
    };
  }

  let rounds = 0;
  let idleTicks = 0;
  const clicks = { expand: 0, viewMore: 0, moreComments: 0, description: 0 };
  for (; rounds < EXPAND_ROUNDS; rounds++) {
    const r = evalFile(page('expand_step.js'), { __ANCHOR: anchor });
    clicks.expand += r.clickedExpand || 0;
    clicks.viewMore += r.clickedViewMore || 0;
    clicks.moreComments += r.clickedMoreComments || 0;
    clicks.description += r.clickedDescription || 0;
    if (!r.clickedExpand && !r.clickedViewMore && !r.clickedDescription && !r.clickedMoreComments) {
      idleTicks++;
      if (idleTicks >= 2) break;
      await sleep(1000);
      continue;
    }
    idleTicks = 0;
    await sleep(1500);
  }

  // Grace retries when round budget exhausted
  if (rounds >= EXPAND_ROUNDS && idleTicks < 2) {
    for (let grace = 0; grace < STUCK_RETRY_ROUNDS; grace++) {
      const r = evalFile(page('expand_step.js'), { __ANCHOR: anchor });
      clicks.expand += r.clickedExpand || 0;
      clicks.viewMore += r.clickedViewMore || 0;
      clicks.moreComments += r.clickedMoreComments || 0;
      clicks.description += r.clickedDescription || 0;
      if (!r.clickedExpand && !r.clickedViewMore && !r.clickedDescription && !r.clickedMoreComments) {
        idleTicks = 2;
        break;
      }
      await sleep(2000);
    }
  }

  // --- Settle loop
  let confirmedZero = 0;
  for (let s = 0; s < SETTLE_ROUNDS; s++) {
    await sleep(1000);
    const unexpanded = evalFile(page('check_collapsed.js'), { __ANCHOR: anchor });
    const pending = (unexpanded?.stillCollapsed || 0) + (unexpanded?.stillHasMoreComments || 0);
    if (pending === 0) {
      confirmedZero++;
      if (confirmedZero >= 2) break;
    } else {
      confirmedZero = 0;
      const r = evalFile(page('expand_step.js'), { __ANCHOR: anchor });
      clicks.expand += r.clickedExpand || 0;
      clicks.viewMore += r.clickedViewMore || 0;
      clicks.moreComments += r.clickedMoreComments || 0;
      clicks.description += r.clickedDescription || 0;
    }
  }

  // Trusted-click fallback for stubborn collapsed posts
  let lastUnexpanded = evalFile(page('check_collapsed.js'), { __ANCHOR: anchor });
  const stubbornCount = (lastUnexpanded?.stillCollapsed || 0) + (lastUnexpanded?.stillHasMoreComments || 0);
  if (stubbornCount > 0) {
    const settleBudget = Math.min(POST_EXPAND_SETTLE_ROUNDS, stubbornCount * 3 + 6);
    let consecutiveClean = 0;
    for (let s = 0; s < settleBudget; s++) {
      const attempt = evalFile(page('expand_step.js'), { __ANCHOR: anchor, __TRUSTED: true });
      clicks.expand += attempt.clickedExpand || 0;
      clicks.viewMore += attempt.clickedViewMore || 0;
      clicks.moreComments += attempt.clickedMoreComments || 0;
      clicks.description += attempt.clickedDescription || 0;
      await sleep(2000);
      lastUnexpanded = evalFile(page('check_collapsed.js'), { __ANCHOR: anchor });
      const remaining = (lastUnexpanded?.stillCollapsed || 0) + (lastUnexpanded?.stillHasMoreComments || 0);
      if (remaining === 0) {
        consecutiveClean++;
        if (consecutiveClean >= 2) break;
      } else {
        consecutiveClean = 0;
      }
    }
  }

  // Article count settle
  let prevCount = -1;
  let matches = 0;
  for (let s = 0; s < SETTLE_ROUNDS; s++) {
    const probeNow = evalFile(page('expand_step.js'), { __ANCHOR: anchor, __PROBE: true });
    const current = probeNow ? probeNow.articles : 0;
    if (current === prevCount && current > 0) {
      matches++;
      if (matches >= 3) break;
    } else {
      prevCount = current;
      matches = 1;
      evalFile(page('expand_step.js'), { __ANCHOR: anchor });
    }
    await sleep(2000);
  }

  // Final pre-extraction gate
  const gateUnexpanded = evalFile(page('check_collapsed.js'), { __ANCHOR: anchor });
  const pendingAfterSettle = (gateUnexpanded?.stillCollapsed || 0) + (gateUnexpanded?.stillHasMoreComments || 0);
  if (pendingAfterSettle > 0) {
    shoot(caseDir, 'capture.png');
    return {
      status: 'blocked',
      retryable: true,
      reason: `expand loop left ${gateUnexpanded.stillCollapsed || 0} collapsed post(s) and ${gateUnexpanded.stillHasMoreComments || 0} "More comments" control(s)`,
      evidence: {
        clicks,
        stillCollapsed: gateUnexpanded.stillCollapsed || 0,
        stillHasMoreComments: gateUnexpanded.stillHasMoreComments || 0,
      },
      expandRounds: rounds,
      timing: { landingMs: landingDurationMs },
    };
  }

  // --- PHASE 2: extract
  // extract_case.js's base64 payload now runs past evalFile's cmd.exe guard
  // (script grew with the Chatter timestamp/role work) — send it over the
  // already-open CDP WebSocket instead, which has no line-length ceiling.
  const raw = await evalFileViaCdp(cdp, page('extract_case.js'));
  if (!raw || !Array.isArray(raw.comments) || raw.comments.length === 0) {
    return { status: 'blocked', reason: 'case extraction returned no comments', timing: { landingMs: landingDurationMs } };
  }

  raw.capture = {
    pendingExpand: gateUnexpanded?.stillCollapsed || 0,
    pendingMoreComments: gateUnexpanded?.stillHasMoreComments || 0,
    clicks,
    screenshot: shoot(caseDir, 'capture.png'),
  };

  const rawPath = join(caseDir, 'case.raw.json');
  writeFileSync(rawPath, JSON.stringify(raw, null, 2), 'utf8');

  // --- Finalize
  const flags = [];
  if (merge) flags.push('--merge');
  if (header.status) flags.push('--status', header.status);
  if (header.priority) flags.push('--priority', header.priority);
  if (!merge && header.title) flags.push('--title', header.title);

  const scrape = node('scrape_case.mjs', [code, rawPath, ...flags]);
  if (scrape.code !== 0) {
    return {
      status: 'blocked',
      reason: `scrape_case.mjs failed: ${scrape.err || scrape.out}`,
      scrapeOut: scrape.out,
      timing: { landingMs: landingDurationMs },
    };
  }

  const v = scrape.json || {};
  const newComments = typeof v.newComments === 'number' ? v.newComments : (cached ? 0 : v.commentCount);

  // --- Render
  const render = node('render_case.mjs', [casePath]);
  const artifacts = {
    mdPath: join(caseDir, 'case.md'),
    casePath,
  };

  // --- QA Gate
  const verified = verifyCase(code, caseDir);
  if (!verified.ok) {
    return {
      status: 'blocked',
      retryable: true,
      reason: `verify_case gate failed: ${verified.errors.join('; ')}`,
      verifyErrors: verified.errors,
      verifyWarnings: verified.warnings,
      timing: { landingMs: landingDurationMs },
    };
  }

  if (merge && newComments === 0 && !v.headerChanged && !v.changed) {
    return {
      status: 'no-update',
      since: cached.extractedAt,
      commentCount: v.commentCount,
      caseUrl: caseUrl || raw.url,
      timing: { landingMs: landingDurationMs },
      diagnostics,
    };
  }

  return {
    status: cached ? 'updated' : 'created',
    commentCount: v.commentCount,
    verified: true,
    ...(verified.warnings.length ? { verifyWarnings: verified.warnings } : {}),
    evidence: raw.capture,
    newComments,
    newCommentIds: v.newCommentIds,
    hash: v.hash,
    ...(v.idCollisions ? { idCollisions: v.idCollisions } : {}),
    title: header.title || undefined,
    caseUrl: caseUrl || raw.url || undefined,
    timing: { landingMs: landingDurationMs },
    dir: caseDir,
    expandRounds: rounds,
    diagnostics,
    ...artifacts,
  };
}

export function parseArgs(argv) {
  const opts = { mode: 'auto' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mode') opts.mode = argv[++i];
  }
  return opts;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const started = Date.now();
  let code = null;
  try {
    code = intake(process.argv[2]);
  } catch (e) {
    const verdict = formatVerdict(process.argv[2] ?? null, { status: 'error', reason: e.message }, started);
    process.stdout.write(JSON.stringify(verdict) + '\n');
    process.exit(1);
  }
  const opts = parseArgs(process.argv.slice(3));
  if (!['auto', 'full', 'update'].includes(opts.mode)) {
    const verdict = formatVerdict(code, { status: 'error', reason: `bad --mode ${opts.mode}` }, started);
    process.stdout.write(JSON.stringify(verdict) + '\n');
    process.exit(1);
  }

  let lock;
  try {
    lock = await acquireLockOrWaitForSameCode(undefined, code);
  } catch (e) {
    const verdict = formatVerdict(code, { status: 'error', reason: `lock acquisition failed: ${e.message}` }, started);
    process.stdout.write(JSON.stringify(verdict) + '\n');
    process.exit(1);
  }
  if (!lock.ok) {
    const waitedNote = lock.waited ? `, waited ${Math.round(lock.waitedMs / 1000)}s for it to finish` : '';
    const verdict = formatVerdict(code, {
      status: 'busy',
      reason: `another capture is running (pid ${lock.holder.pid} since ${lock.holder.at})${waitedNote}`,
      waited: lock.waited,
      waitedMs: lock.waitedMs,
    }, started);
    process.stdout.write(JSON.stringify(verdict) + '\n');
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
      const verdict = formatVerdict(code, { ...v, waited: lock.waited, waitedMs: lock.waitedMs }, started);
      process.stdout.write(JSON.stringify(verdict) + '\n');
      process.exit(STATUS_EXIT[verdict.status] ?? 1);
    });
}
