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
//   otp-timeout                     -> exit 2  (password autofilled, but OTP timed out)
//   auth-required                   -> exit 3  (human must finish Okta/OTP once)
//   not-found                       -> exit 4  (wrong code, or no access)
//   blocked                         -> exit 5  (page never rendered / capture short)
//   busy                            -> exit 6  (another capture holds the lock — retry later)
//   port-conflict                   -> exit 7  (CDP port held by a process that isn't our
//                                                Chrome — see recover_chrome.ps1, issue #104)
//   error                           -> exit 1
//
// "blocked" is never downgraded to "no-update": a tool failure means
// inconclusive, not "confirmed unchanged" (SKILL.md hard rule).
//
// `retryable: true` on a `blocked` verdict marks a transient capture glitch
// (e.g. a stuck expand loop) worth retrying.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, QUALCOMM_USER, SECRET_PATH } from './_paths.mjs';
import { intake } from './intake.mjs';
import { acquireLockOrWaitForSameCode, releaseLock } from './lock.mjs';
import * as browser from './browser.mjs';
import { BrowserError, CDP_PORT, PortConflictError } from './browser.mjs';
import * as fastLanding from './fast_landing.mjs';
import { CdpPortalDriver } from './cdp_portal_driver.mjs';
import { FixturePortalDriver } from './fixture_portal_driver.mjs';
import { finalize, EXIT as FINALIZE_EXIT } from './finalize_case.mjs';
import { renderCase } from './render_case.mjs';
import { verifyCase } from './verify_case.mjs';
import { ensureProtocolRegistered } from './ensure_protocol.mjs';

const PORTAL = 'https://support.qualcomm.com';

// Set once at module load: the CLI process itself (not just an in-process
// caller passing opts.driver) can then run offline against
// FixturePortalDriver — see fixture_portal_driver.mjs and #241.
// run_summary.mjs's captureCase() spawns this file as a child process and
// forwards its own env, so setting this once at the top of a test also
// covers that subprocess for free.
const USE_FIXTURE_DRIVER = Boolean(process.env.QCOMM_FIXTURE_DIR);

export const STATUS_EXIT = {
  created: 0, updated: 0, 'no-update': 0,
  'otp-timeout': 2,
  'auth-required': 3, 'not-found': 4, blocked: 5, busy: 6, 'port-conflict': 7, error: 1,
};

const norm = s => String(s || '').replace(/\s+/g, ' ').trim();

/** Anchor = the newest CACHED comment; PHASE 1.5B stops paginating there. */
export function anchorOf(cached) {
  const c = cached && Array.isArray(cached.comments) && cached.comments[0];
  return c ? { author: c.author, bodyStart: norm(c.body).slice(0, 80) } : null;
}

/**
 * Detail tab is the only tab that actually renders `fields`; Feed-tab `raw` can still
 * stumble onto a non-empty value for them (wrong DOM region), so detailRaw wins whenever
 * present, and raw is the fallback only when detailRaw didn't capture the field.
 * Mutates and returns `raw`.
 */
export function mergeDetailFields(raw, detailRaw, fields) {
  if (!detailRaw) return raw;
  for (const f of fields) {
    if (detailRaw[f]) raw[f] = detailRaw[f];
  }
  return raw;
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
 * comes from drifts between reads of an identical thread (see dom_extractor.js's
 * QC.extractCase), so it can neither confirm nor deny a change.
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
async function shoot(dir, name, driver) {
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    await driver.screenshot(join(dir, name));
    return name;
  } catch (e) {
    process.stderr.write(`screenshot failed (${name}): ${e.message}\n`);
    return null;
  }
}

export async function run(code, opts = {}) {
  const caseDir = join(DATA_DIR, code);
  const casePath = join(caseDir, 'case.json');
  // Strip a possible leading BOM (e.g. a cache hand-edited on Windows) — same
  // defensive read as finalize_case.mjs and render_case.mjs do for this same file.
  let cached = null;
  if (existsSync(casePath)) {
    const t = readFileSync(casePath, 'utf8');
    cached = JSON.parse(t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t);
  }
  const mode = opts.mode === 'auto' ? (cached ? 'update' : 'full') : opts.mode;
  const merge = mode === 'update' && !!cached;
  const anchor = merge ? anchorOf(cached) : null;

  const driver = opts.driver
    || (USE_FIXTURE_DRIVER ? new FixturePortalDriver() : new CdpPortalDriver({ cdp: opts.cdp, browser, fastLanding }));
  await driver.connect();

  if (!driver.isConnected()) {
    return {
      status: 'blocked',
      reason: `CDP client connection unavailable on port ${CDP_PORT} (check Chrome instance)`,
    };
  }

  const landed = await driver.navigateToCase(code, {
    cached,
    portalUrl: PORTAL,
    secretPath: opts.secretPath,
    username: opts.username || QUALCOMM_USER,
    fillRetryLimit: opts.fillRetryLimit,
    otpTimeoutMs: opts.otpTimeoutMs,
    otpPollIntervalMs: opts.otpPollIntervalMs,
  });
  const landingDurationMs = landed.durationMs || 0;
  const diagnostics = landed.diagnostics || [];

  if (landed.state === 'OTP_TIMEOUT') {
    const shot = await shoot(caseDir, 'otp_timeout.png', driver);
    return {
      status: 'otp-timeout',
      reason: landed.reason || 'Password accepted, but OTP verification was not completed within the timeout window',
      url: landed.url,
      caseUrl: landed.url,
      timing: { landingMs: landingDurationMs },
      diagnostics,
      screenshot: shot,
    };
  }
  if (landed.state === 'AUTH') {
    const shot = await shoot(caseDir, 'auth_required.png', driver);
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
    const shot = await shoot(caseDir, 'not_found.png', driver);
    return {
      status: 'not-found',
      reason: landed.reason || `no search result for ${code} (wrong code, or the account cannot see it)`,
      timing: { landingMs: landingDurationMs },
      diagnostics,
      screenshot: shot,
    };
  }
  if (landed.state === 'STUB') {
    const shot = await shoot(caseDir, 'landing_failure.png', driver);
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
    const shot = await shoot(caseDir, 'landing_failure.png', driver);
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

  // Detail-tab extraction, Feed-tab switch-back, feed probe (with the fast
  // no-update short-circuit), expand/settle loop, and final DOM extraction
  // all happen inside the driver now — see cdp_portal_driver.mjs for the
  // page-interaction sequence (unchanged) and portal_driver.mjs for the
  // { ok, stage, reason, ... } descriptor contract this reads.
  const expandResult = await driver.expandAndExtract({
    anchor,
    caseUrl,
    onProbe: probe => merge && isNoUpdate(probe, cached),
  });

  if (!expandResult.ok) {
    if (expandResult.stage === 'feed-switch') {
      const shot = await shoot(caseDir, 'feed_switch_failed.png', driver);
      return {
        status: 'blocked',
        retryable: true,
        reason: expandResult.reason,
        caseUrl,
        timing: { landingMs: landingDurationMs },
        diagnostics,
        screenshot: shot,
      };
    }
    if (expandResult.stage === 'no-articles') {
      const shot = await shoot(caseDir, 'feed_missing.png', driver);
      return {
        status: 'blocked',
        reason: expandResult.reason,
        probe: expandResult.probe,
        caseUrl,
        timing: { landingMs: landingDurationMs },
        diagnostics,
        screenshot: shot,
      };
    }
    if (expandResult.stage === 'stuck-expand') {
      await shoot(caseDir, 'capture.png', driver);
      return {
        status: 'blocked',
        retryable: true,
        reason: expandResult.reason,
        evidence: expandResult.evidence,
        expandRounds: expandResult.rounds,
        timing: { landingMs: landingDurationMs },
      };
    }
    // 'no-comments'
    return { status: 'blocked', reason: expandResult.reason, timing: { landingMs: landingDurationMs } };
  }

  if (expandResult.noUpdate) {
    const shot = await shoot(caseDir, 'probe.png', driver);
    return {
      status: 'no-update', since: cached.extractedAt,
      commentCount: cached.comments.length,
      caseUrl: caseUrl || cached.caseUrl || cached.url,
      timing: { landingMs: landingDurationMs },
      diagnostics,
      evidence: { articles: expandResult.probe.articles, pendingExpand: 0, pendingMoreComments: 0, screenshot: shot },
    };
  }

  const { raw, detailRaw, detailExtracted, detailSwitchError, clicks, pendingExpand, pendingMoreComments, rounds } = expandResult;

  // Merge any metadata captured from Detail tab
  mergeDetailFields(raw, detailRaw, [
    'contactName',
    'openedAt',
    'closedAt',
    'customerProject',
    'customerTracking',
    'accountName',
    'relatedCRs',
    'caseRecordType',
    'description',
    'title',
    'status',
    'priority',
    'severity',
    'product',
    'updated',
  ]);

  raw.detailExtracted = detailExtracted;
  raw.capture = {
    pendingExpand,
    pendingMoreComments,
    clicks,
    detailTabExtracted: detailExtracted,
    ...(detailSwitchError ? { detailSwitchError } : {}),
    screenshot: await shoot(caseDir, 'capture.png', driver),
  };

  const rawPath = join(caseDir, 'case.raw.json');
  writeFileSync(rawPath, JSON.stringify(raw, null, 2), 'utf8');

  // --- Finalize
  // Same overrides a CLI-flags call would have produced: status/priority always
  // win when present, but title is withheld on --merge (an update run trusts the
  // already-cached title over a possibly-stale search-row value).
  const headerOverride = {
    ...(header.status ? { status: header.status } : {}),
    ...(header.priority ? { priority: header.priority } : {}),
    ...(!merge && header.title ? { title: header.title } : {}),
  };
  const result = finalize(code, rawPath, headerOverride, merge);
  if (result.code !== FINALIZE_EXIT.OK) {
    return {
      status: 'blocked',
      reason: result.reason || `finalize_case.mjs gate failed (code ${result.code})`,
      finalizeCode: result.code,
      timing: { landingMs: landingDurationMs },
    };
  }

  const v = result;
  const newComments = typeof v.newComments === 'number' ? v.newComments : (cached ? 0 : v.commentCount);

  // --- Render
  let artifacts;
  try {
    const mdPath = renderCase(casePath);
    artifacts = { mdPath, casePath };
  } catch (e) {
    return {
      status: 'blocked',
      reason: `render_case.mjs failed: ${e.message}`,
      timing: { landingMs: landingDurationMs },
    };
  }

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
    detailTabExtracted: detailExtracted,
    ...(detailSwitchError ? { detailSwitchError } : {}),
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
    if (argv[i] === '--username' || argv[i] === '--user') opts.username = argv[++i];
  }
  return opts;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    ensureProtocolRegistered({ silent: true });
  } catch {}
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

  const resolvedUsername = opts.username || QUALCOMM_USER;
  const resolvedSecretPath = opts.secretPath || SECRET_PATH;
  // FixturePortalDriver never logs in, so offline/fixture runs (#241) have no
  // credentials to check.
  if (!USE_FIXTURE_DRIVER && (!resolvedUsername || !existsSync(resolvedSecretPath))) {
    const missing = [];
    if (!resolvedUsername) missing.push('Qualcomm ID (username)');
    if (!existsSync(resolvedSecretPath)) missing.push('Qualcomm ID password');
    const verdict = formatVerdict(code, {
      status: 'error',
      reason: `Qualcomm credentials not configured (missing ${missing.join(', ')}). Please run: npm run setup:credentials`
    }, started);
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
      status: e instanceof PortConflictError ? 'port-conflict' : (e instanceof BrowserError ? 'blocked' : 'error'),
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
