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
//
// `retryable: true` on a `blocked` verdict marks a transient capture glitch
// (e.g. a stuck expand loop) worth hammering again soon — scheduler.mjs skips
// stamping lastRunAt for these so the case stays due next sweep tick instead
// of waiting out the full interval, bounded by MAX_RETRYABLE_ATTEMPTS.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DATA_DIR } from './_paths.mjs';
import { intake } from './intake.mjs';
import { acquireLock, releaseLock } from './lock.mjs';
import { BrowserError, click, ensureChrome, evalFile, open, pdf, screenshot, sleep } from './browser.mjs';
import { verifyCase } from './verify_case.mjs';

const SCRIPTS = fileURLToPath(new URL('.', import.meta.url));
const PORTAL = 'https://support.qualcomm.com';
const READY_ROUNDS = 8;      // x 2s = 16s ceiling for SPA hydration
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

export async function run(code, opts) {
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
    // Screenshot the untouched feed too: "no update" is a claim about what the
    // page showed, and this is the only artifact that can back it up later.
    const shot = shoot(caseDir, 'probe.png');
    return {
      status: 'no-update', since: cached.extractedAt,
      commentCount: cached.comments.length,
      evidence: { articles: probe.articles, pendingExpand: 0, pendingMoreComments: 0, screenshot: shot },
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
  // Click tally, persisted with the capture: the verdict says a case is
  // complete, this says what was actually done to make it so.
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
    await sleep(r.clickedViewMore ? 2000 : 800);
  }

  // The round budget can run out while a control is STILL being clicked every
  // tick (idleTicks never reached 2) — a click that never actually expands its
  // post (e.g. the synthetic click missed the framework's real handler) looks
  // identical to real progress here, since the label never changes and gets
  // "clicked" again next tick. Extracting now would silently persist a
  // truncated body ending in the literal "Expand Post" control label (observed
  // on case 08503838: 7 of 11 comments). Give it a few slower, dedicated
  // retries; only give up loud — never fall through to extraction quiet.
  // It does NOT return blocked here. The trusted-click settle loop below is the
  // one mechanism known to actually expand this control, so bailing out at the
  // first sign of a stuck synthetic click made the recovery unreachable exactly
  // when it was needed. Give the tick loop its grace retries, then fall through
  // and let the settle loop (and, failing that, the extraction-time gate) decide.
  if (rounds >= EXPAND_ROUNDS && idleTicks < 2) {
    for (let i = 0; i < STUCK_RETRY_ROUNDS; i++) {
      await sleep(2000);
      const r = evalFile(page('expand_step.js'), { __ANCHOR: anchor });
      clicks.expand += r.clickedExpand || 0;
      clicks.viewMore += r.clickedViewMore || 0;
      clicks.moreComments += r.clickedMoreComments || 0;
      clicks.description += r.clickedDescription || 0;
      if (!r.clickedExpand && !r.clickedViewMore && !r.clickedDescription && !r.clickedMoreComments) break;
    }
  }

  // expand_step.js's in-page synthetic events (pointerdown/mousedown/up +
  // .click()) can silently no-op on the Chatter "Expand Post" control even
  // though byText() found and "fired" it every tick — Aura's real handler
  // just doesn't respond to dispatched events for this control (confirmed on
  // case 08417053: a real CDP-level click on the identical element expands it
  // immediately; 5 consecutive full automated runs relying on fire() alone
  // never expanded it once, deterministically, not a timing flake). Fall back
  // to a real trusted click — the same mechanism already used for the case-
  // link route above — on any post still showing the label once the tick
  // loop above has given up.
  //
  // The detection MUST be a separate, non-firing read (check_collapsed.js),
  // not another call to expand_step.js: calling fire() has an observable
  // side effect on this control's rendered text even when it doesn't
  // actually expand it, so a settle-check that itself re-fires on every call
  // was self-poisoning its own reading (measured: reads 0 right after firing,
  // 3 on an untouched read of the identical DOM at the same instant).
  // `a.cuf-more` alone always resolves to the FIRST DOM match regardless of
  // visibility — once that one is clicked (and hidden), re-clicking the same
  // selector keeps hitting the now-hidden element and never advances to the
  // next post (observed: case 08417053, only 1 of 3 collapsed posts recovered
  // across the whole retry budget). Scope to the still-visible one each round.
  //
  // A single clean read isn't trustworthy either (observed: case 08324806,
  // the very first check_collapsed.js read after the tick loop reported 0
  // while the DOM still needed one more click, same class of transient
  // mis-read as the tick loop's own idle detection above) — require 2
  // consecutive clean reads before concluding nothing is left, same
  // philosophy as probeFeed()'s steady-count check and the tick loop's own
  // idleTicks >= 2 above.
  //
  // The budget scales with the work: this loop clicks ONE control per round
  // (`a.cuf-more:not(.hidden)` always resolves to the first still-visible one),
  // so a feed with 11 collapsed posts cannot be cleared in 8 rounds — the fixed
  // budget is why case 08503838 kept extracting with 3 posts still collapsed.
  let cleanReads = 0;
  let lastCheck = null;
  let settleCap = SETTLE_ROUNDS;
  for (let i = 0; i < settleCap && cleanReads < 2; i++) {
    const s = evalFile(page('check_collapsed.js'), { __ANCHOR: anchor });
    if (i === 0) settleCap = Math.max(SETTLE_ROUNDS, (s.stillCollapsed || 0) * 3 + 6);
    lastCheck = s;
    if (s.stillCollapsed || s.stillHasMoreComments) {
      cleanReads = 0;
      try { click('a.cuf-more:not(.hidden)'); } catch { /* nothing left visible to click — fine */ }
      // "More comments" nested-reply pagination has no known trusted-click
      // selector yet (unlike Expand Post's a.cuf-more) — re-fire the
      // synthetic-event path as the only available retry.
      if (s.stillHasMoreComments) evalFile(page('expand_step.js'), { __ANCHOR: anchor });
    } else {
      cleanReads++;
    }
    await sleep(1000);
  }

  // Anything this loop could not clear (a collapsed post, an unopened reply
  // thread) is caught by the extraction-time gate below — one place, with the
  // evidence and screenshot attached, instead of two half-informed exits.

  // The case page keeps a CometD/Streaming-API worker alive (confirmed via
  // /json/list: a `streaming-v2/CometdWorkerJs.js` shared_worker on the case
  // tab), which live-pushes Chatter activity and makes the LWC framework
  // intermittently tear down and rebuild parts of the feed's DOM tree — NOT
  // gated by any click, scroll, or pagination control. A raw article-count
  // read can land mid-rebuild and see a partial tree (observed on case
  // 08503838: consecutive reads with zero clicks in between returning 11, 4,
  // 12, 17, 11 on the SAME tab). probeFeed() only guards the count BEFORE
  // expansion starts; without an equivalent guard here, extraction can run
  // during one of these dips and silently persist a partial capture — the
  // exact failure mode that dropped a reply to "...SMs_emm_rrc_handler.c.7z"
  // entirely out of case.json with no error. Requiring only 2 consecutive
  // matching reads is not enough — the flicker can span several ticks — so
  // this requires 3, spread across a longer window (same steady-count
  // philosophy as probeFeed/idleTicks/cleanReads above, just with a bigger
  // budget to outlast a render cycle instead of a click).
  let articleReads = 0;
  let lastArticles = -1;
  for (let i = 0; i < POST_EXPAND_SETTLE_ROUNDS && articleReads < 3; i++) {
    const p = evalFile(page('expand_step.js'), { __ANCHOR: anchor, __PROBE: true });
    const n = p ? p.articles : lastArticles;
    if (n === lastArticles) {
      articleReads++;
    } else {
      articleReads = 0;
      lastArticles = n;
      evalFile(page('expand_step.js'), { __ANCHOR: anchor });
    }
    await sleep(2000);
  }

  // --- PHASE 2: extract from the DOM exactly as expansion left it.
  //
  // One last non-firing read FIRST: the article-settle loop above can click
  // again, so the settle loop's `lastCheck` is not necessarily what the DOM
  // looks like at extraction time. Evidence has to describe the state the
  // extractor actually ran on, or it is decoration.
  const finalCheck = evalFile(page('check_collapsed.js'), { __ANCHOR: anchor }) || {};
  if (finalCheck.stillCollapsed || finalCheck.stillHasMoreComments) {
    return {
      status: 'blocked',
      retryable: true,
      reason: `feed still hides content at extraction time (${finalCheck.stillCollapsed || 0} collapsed post(s), ${finalCheck.stillHasMoreComments || 0} unopened reply thread(s))`,
      expandRounds: rounds,
      evidence: { ...finalCheck, clicks, screenshot: shoot(caseDir, 'capture.png') },
    };
  }

  // Visual evidence of the fully-expanded feed, taken BEFORE extraction so the
  // PNG and case.json describe the same DOM.
  const shotName = shoot(caseDir, 'capture.png');

  const raw = evalFile(page('extract_case.js'));
  if (!raw || !Array.isArray(raw.comments)) {
    return { status: 'blocked', reason: 'extractor returned no comments array', raw: typeof raw };
  }
  // Travels with the raw capture so scrape_case.mjs can persist it into
  // case.json — an audit trail that outlives the run's stderr.
  raw.capture = {
    articles: raw.comments.length,
    pendingExpand: finalCheck.stillCollapsed ?? null,
    pendingMoreComments: finalCheck.stillHasMoreComments ?? null,
    expandRounds: rounds,
    clicks,
    screenshot: shotName,
    mode,
  };
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
  // A short/collapsed capture is the same class of transient glitch as the
  // stuck-expand-loop check above — retryable, not a persistent structural
  // failure, so the scheduler should retry it soon rather than wait a full interval.
  if (fin.code === 5) return { status: 'blocked', retryable: true, reason: v.reason || 'incomplete capture', finalize: v, expandRounds: rounds };
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

  // --- PHASE 4.5: QA gate. verify_case.mjs re-reads only what was persisted, so
  // it catches anything the capture path could have let through (a collapsed
  // body, a rendered file the data never reached, colliding ids) independently
  // of the code that produced it. It used to be an opt-in script nothing called,
  // which is how a capture could report success without anything checking it.
  const verified = verifyCase(code, caseDir);
  if (!verified.ok) {
    return {
      status: 'blocked',
      retryable: true,
      reason: `post-capture verification failed: ${verified.errors[0]}`,
      verifyErrors: verified.errors,
      dir: caseDir,
      expandRounds: rounds,
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
  // Guarded: an fs error here (disk full, permission) must still emit the ONE
  // JSON verdict line the whole contract promises, not an uncaught crash with
  // empty stdout and nothing for the caller to branch on.
  let lock;
  try {
    lock = acquireLock();
  } catch (e) {
    process.stdout.write(JSON.stringify({ code, status: 'error', reason: `lock acquisition failed: ${e.message}` }) + '\n');
    process.exit(1);
  }
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
