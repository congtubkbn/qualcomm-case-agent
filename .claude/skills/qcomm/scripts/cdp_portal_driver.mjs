// Production PortalDriver: drives the persistent-profile Chrome over CDP.
//
// This is a code MOVE, not a rewrite: the detail-tab/feed-switch/probe/
// expand/settle/extract sequence below is lifted verbatim from run_case.mjs
// (see git history on that file for the case-number regressions each retry
// loop and settle pass exists to guard against — 08503838, 08417053,
// 08637663). Only the wrapping changed: it now returns a neutral
// { ok, stage, reason, ... } descriptor instead of a verdict shape, so
// run_case.mjs (the only caller) keeps owning verdicts/timing/diagnostics.
//
// Everything that touches browser.mjs or fast_landing.mjs lives here now —
// run_case.mjs holds no reference to evalFileViaCdp, a CDP client,
// ensureChrome, BrowserError/PortConflictError, or fastLandOnCase; it just
// imports both modules once (as it always has) and hands the namespaces to
// this constructor. connect() catches BrowserError/PortConflictError the
// same way expandAndExtract() catches its own failure modes — into the
// neutral descriptor above, never letting the concrete error classes cross
// the seam.
//
// Why `browser`/`fastLanding` are injected rather than imported here
// directly: tests mock browser.mjs and fast_landing.mjs per-test via node's
// experimental module mocker, but only the module that IMPORTS one of them
// fresh each test observes that mock — run_case.mjs gets re-imported with a
// cache-busting query per test, so its own `import * as x from './x.mjs'`
// re-resolves against whichever mock is active for that test. This file is
// not re-imported per test (no query-bust), so a static import here would
// bind ONCE to whatever was live at the time and silently stop tracking
// later tests' mocks.

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PortalDriver } from './portal_driver.mjs';
import { repeatUntilStable } from './repeat_until_stable.mjs';

const SCRIPTS = fileURLToPath(new URL('.', import.meta.url));
const page = name => join(SCRIPTS, name);

export const FEED_PROBE_ROUNDS = 15; // x 2s = 30s ceiling — Chatter feed hydration is
                                     // slower than page readiness right after a fresh
                                     // login (cold Lightning component bootstrap)
export const EXPAND_ROUNDS = 40;    // pagination + expansion ticks
export const STUCK_RETRY_ROUNDS = 5; // x2s extra grace once the round budget runs out
                                     // while still clicking "Expand Post" every tick
export const SETTLE_ROUNDS = 8;      // x1s ceiling (incl. 2 mandatory confirm reads)
export const POST_EXPAND_SETTLE_ROUNDS = 15; // x2s ceiling for any post still showing
                                             // "Expand Post" to get a real click and settle
                                             // before extraction
export const DETAIL_SWITCH_RETRIES = 3;

// Single place every expand-loop call site folds an expandStep result's click
// counters into the running tally — the count-stabilize loop used to skip
// this and silently drop its clicks (issue #273).
function accumulateClicks(clicks, r) {
  clicks.expand += r.clickedExpand || 0;
  clicks.viewMore += r.clickedViewMore || 0;
  clicks.moreComments += r.clickedMoreComments || 0;
  clicks.description += r.clickedDescription || 0;
}

// Shared shape behind the main-expand and stuck-retry-grace repeatUntilStable
// calls: fetch one expandStep, fold its clicks into the running tally, sleep
// activeSleepMs on a click and idleSleepMs on idle — except on the tick that
// reaches stableTarget consecutive idle ticks, which ends the loop and so
// gets no sleep at all (matches the pre-migration raw loops, which broke
// immediately on their last idle tick rather than sleeping first).
function makeExpandTick({ evalFileViaCdp, cdp, anchor, clicks, activeSleepMs, idleSleepMs, stableTarget, sleep }) {
  let consecutiveIdle = 0;
  return async () => {
    const r = await evalFileViaCdp(cdp, page('dom_extractor.js'), { __ACTION: 'expandStep', __ANCHOR: anchor });
    accumulateClicks(clicks, r);
    const isIdle = !r.clickedExpand && !r.clickedViewMore && !r.clickedDescription && !r.clickedMoreComments;
    if (!isIdle) {
      consecutiveIdle = 0;
      await sleep(activeSleepMs);
    } else {
      consecutiveIdle++;
      if (consecutiveIdle < stableTarget) await sleep(idleSleepMs);
    }
    return isIdle;
  };
}

export class CdpPortalDriver extends PortalDriver {
  /**
   * @param {Object} [options]
   * @param {import('./cdp_client.mjs').CdpClient} [options.cdp] Pre-connected client (test/programmatic seam)
   * @param {typeof import('./browser.mjs')} options.browser The browser.mjs namespace — see file header for why this is injected, not imported.
   * @param {typeof import('./fast_landing.mjs')} options.fastLanding The fast_landing.mjs namespace — same reason.
   */
  constructor({ cdp = null, browser, fastLanding } = {}) {
    super();
    if (!browser) throw new Error('CdpPortalDriver requires { browser } — the browser.mjs namespace');
    if (!fastLanding) throw new Error('CdpPortalDriver requires { fastLanding } — the fast_landing.mjs namespace');
    this.cdp = cdp;
    this.browser = browser;
    this.fastLanding = fastLanding;
    this._ownsCdp = !cdp; // never close a connection the caller handed us
  }

  // Neutral descriptor on failure — { ok: false, stage: 'port-conflict' | 'blocked',
  // reason, detail? } — the same convention expandAndExtract() uses, so
  // run_case.mjs never needs to import or instanceof-check browser.mjs's
  // BrowserError/PortConflictError to build a verdict.
  async connect() {
    try {
      await this.browser.ensureChrome();
    } catch (e) {
      this.cdp = null; // isConnected() must reflect the failure even if a cdp was pre-injected
      return { ok: false, stage: e.name === 'PortConflictError' ? 'port-conflict' : 'blocked', reason: e.message, ...(e.detail !== undefined ? { detail: e.detail } : {}) };
    }
    if (this.cdp) return { ok: true }; // pre-injected (test/programmatic seam)
    try {
      this.cdp = await this.browser.getCdpClient();
    } catch (e) {
      process.stderr.write(`[CDP] Direct connection failed: ${e.message}\n`);
      this.cdp = null;
      return { ok: false, stage: 'blocked', reason: e.message };
    }
    return { ok: true };
  }

  isConnected() {
    return !!(this.cdp && (typeof this.cdp.isConnected !== 'function' || this.cdp.isConnected()));
  }

  async navigateToCase(code, opts = {}) {
    return this.fastLanding.fastLandOnCase(code, { cdp: this.cdp, ...opts });
  }

  async screenshot(path, opts = {}) {
    return this.browser.screenshot(path, { cdp: this.cdp, ...opts });
  }

  async expandAndExtract({ anchor = null, caseUrl = null, onProbe = null } = {}) {
    const cdp = this.cdp;
    const { evalFileViaCdp, open, sleep } = this.browser;

    let detailRaw = null;
    let detailExtracted = false;
    let detailSwitchError = null;
    for (let attempt = 0; attempt < DETAIL_SWITCH_RETRIES; attempt++) {
      try {
        const tabSwitch = await evalFileViaCdp(cdp, page('dom_extractor.js'), { __ACTION: 'switchTab', __TARGET_TAB: 'Detail' });
        if (tabSwitch && (tabSwitch.ok || tabSwitch.alreadyActive)) {
          await sleep(1000);
          detailRaw = await evalFileViaCdp(cdp, page('dom_extractor.js'), { __ACTION: 'extractCase' });
          if (detailRaw) {
            detailExtracted = true;
            detailSwitchError = null;
            break;
          } else {
            detailSwitchError = 'extractCase returned null or empty on Detail tab';
          }
        } else {
          detailSwitchError = tabSwitch?.reason || 'switch_tab failed to switch to Detail tab';
        }
      } catch (e) {
        detailSwitchError = e?.message || String(e);
      }
      if (attempt < DETAIL_SWITCH_RETRIES - 1) {
        await sleep(1000);
      }
    }

    // A failed switch-back must not be silently swallowed (case 08637663: this
    // org labels the tab "Communication" rather than "Feed"; every
    // visibility-dependent check downstream then reads the hidden Feed panel
    // as "nothing left to expand", under-capturing comments with no error
    // anywhere) — so a failure here is a hard stop, not a warning.
    let feedSwitched = false;
    let feedSwitchError = null;
    for (let attempt = 0; attempt < DETAIL_SWITCH_RETRIES; attempt++) {
      try {
        const switchBack = await evalFileViaCdp(cdp, page('dom_extractor.js'), { __ACTION: 'switchTab', __TARGET_TAB: 'Feed' });
        if (switchBack && (switchBack.ok || switchBack.alreadyActive)) {
          feedSwitched = true;
          feedSwitchError = null;
          break;
        }
        feedSwitchError = switchBack?.reason || 'switch_tab failed to switch to Feed tab';
      } catch (e) {
        feedSwitchError = e?.message || String(e);
      }
      if (attempt < DETAIL_SWITCH_RETRIES - 1) {
        await sleep(500);
      }
    }
    if (!feedSwitched) {
      return {
        ok: false,
        stage: 'feed-switch',
        reason: `could not switch back to the Feed tab for extraction: ${feedSwitchError}`,
        retryable: true,
      };
    }
    await sleep(500);

    const probeFeed = async () => {
      const { value } = await repeatUntilStable({
        tick: () => evalFileViaCdp(cdp, page('dom_extractor.js'), { __ACTION: 'expandStep', __ANCHOR: anchor, __PROBE: true }),
        isStable: (current, previous) => {
          const prevArticles = previous ? previous.articles : 0;
          return !!(current && current.articles && current.articles === prevArticles);
        },
        stableTarget: 1,
        maxRounds: FEED_PROBE_ROUNDS + 1,
        sleepMs: 2000,
        sleep,
      });
      return value;
    };

    let probe = await probeFeed();
    if (!probe || !probe.articles) {
      if (caseUrl) {
        try {
          if (typeof cdp.navigate === 'function') {
            await cdp.navigate(caseUrl);
          } else {
            open(caseUrl);
          }
        } catch (e) {
          return { ok: false, stage: 'no-articles', reason: `could not reopen case page for a feed retry: ${e.message}` };
        }
        probe = await probeFeed();
      }
    }
    if (!probe || !probe.articles) {
      return {
        ok: false,
        stage: 'no-articles',
        reason: 'case page has no Chatter feed articles — wrong page or feed never loaded',
        probe,
      };
    }
    if (typeof onProbe === 'function' && onProbe(probe, detailRaw)) {
      return { ok: true, noUpdate: true, probe };
    }

    let rounds = 0;
    let idleTicks = 0;
    const clicks = { expand: 0, viewMore: 0, moreComments: 0, description: 0 };

    const mainLoop = await repeatUntilStable({
      tick: makeExpandTick({ evalFileViaCdp, cdp, anchor, clicks, activeSleepMs: 1500, idleSleepMs: 1000, stableTarget: 2, sleep }),
      isStable: (current) => current,
      stableTarget: 2,
      maxRounds: EXPAND_ROUNDS,
      sleepMs: 0,
      sleep,
    });
    // mainLoop.rounds counts every tick it ran, including the terminating
    // one when it stops early — the raw for-loop this replaced (`for (;
    // rounds < EXPAND_ROUNDS; rounds++)`) never incremented `rounds` for the
    // iteration that hit `break`, so subtract 1 to match. `rounds` is
    // returned as-is in the stuck-expand/final-gate descriptors below, so
    // this keeps that diagnostic value identical to the pre-migration loop.
    rounds = mainLoop.stable ? mainLoop.rounds - 1 : mainLoop.rounds;
    idleTicks = mainLoop.stable ? 2 : 0;

    if (rounds >= EXPAND_ROUNDS && idleTicks < 2) {
      const graceLoop = await repeatUntilStable({
        // idleSleepMs: 0 — with stableTarget: 1, every idle tick is the
        // terminating one, so the idle branch never actually sleeps.
        tick: makeExpandTick({ evalFileViaCdp, cdp, anchor, clicks, activeSleepMs: 2000, idleSleepMs: 0, stableTarget: 1, sleep }),
        isStable: (current) => current,
        stableTarget: 1,
        maxRounds: STUCK_RETRY_ROUNDS,
        sleepMs: 0,
        sleep,
      });
      if (graceLoop.stable) idleTicks = 2;
    }

    await repeatUntilStable({
      tick: async () => {
        await sleep(1000);
        const unexpanded = await evalFileViaCdp(cdp, page('dom_extractor.js'), { __ACTION: 'checkCollapsed', __ANCHOR: anchor });
        const pending = (unexpanded?.stillCollapsed || 0) + (unexpanded?.stillHasMoreComments || 0);
        if (pending > 0) {
          const r = await evalFileViaCdp(cdp, page('dom_extractor.js'), { __ACTION: 'expandStep', __ANCHOR: anchor });
          accumulateClicks(clicks, r);
        }
        return pending === 0;
      },
      isStable: (current) => current,
      stableTarget: 2,
      maxRounds: SETTLE_ROUNDS,
      sleepMs: 0,
      sleep: (ms) => ms === 0 ? Promise.resolve() : sleep(ms),
    });

    let lastUnexpanded = await evalFileViaCdp(cdp, page('dom_extractor.js'), { __ACTION: 'checkCollapsed', __ANCHOR: anchor });
    const stubbornCount = (lastUnexpanded?.stillCollapsed || 0) + (lastUnexpanded?.stillHasMoreComments || 0);
    if (stubbornCount > 0) {
      const settleBudget = Math.min(POST_EXPAND_SETTLE_ROUNDS, stubbornCount * 3 + 6);
      await repeatUntilStable({
        tick: async () => {
          const attempt = await evalFileViaCdp(cdp, page('dom_extractor.js'), { __ACTION: 'expandStep', __ANCHOR: anchor, __TRUSTED: true });
          accumulateClicks(clicks, attempt);
          await sleep(2000);
          const unexpanded = await evalFileViaCdp(cdp, page('dom_extractor.js'), { __ACTION: 'checkCollapsed', __ANCHOR: anchor });
          const remaining = (unexpanded?.stillCollapsed || 0) + (unexpanded?.stillHasMoreComments || 0);
          return remaining === 0;
        },
        isStable: (current) => current,
        stableTarget: 2,
        maxRounds: settleBudget,
        sleepMs: 0,
        sleep: (ms) => ms === 0 ? Promise.resolve() : sleep(ms),
      });
    }

    let prevCount = -1;
    let matches = 0;
    for (let s = 0; s < SETTLE_ROUNDS; s++) {
      const probeNow = await evalFileViaCdp(cdp, page('dom_extractor.js'), { __ACTION: 'expandStep', __ANCHOR: anchor, __PROBE: true });
      const current = probeNow ? probeNow.articles : 0;
      if (current === prevCount && current > 0) {
        matches++;
        if (matches >= 3) break;
      } else {
        prevCount = current;
        matches = 1;
        const r = await evalFileViaCdp(cdp, page('dom_extractor.js'), { __ACTION: 'expandStep', __ANCHOR: anchor });
        accumulateClicks(clicks, r);
      }
      await sleep(2000);
    }

    const gateUnexpanded = await evalFileViaCdp(cdp, page('dom_extractor.js'), { __ACTION: 'checkCollapsed', __ANCHOR: anchor });
    const pendingExpand = gateUnexpanded?.stillCollapsed || 0;
    const pendingMoreComments = gateUnexpanded?.stillHasMoreComments || 0;
    if (pendingExpand + pendingMoreComments > 0) {
      return {
        ok: false,
        stage: 'stuck-expand',
        reason: `expand loop left ${pendingExpand} collapsed post(s) and ${pendingMoreComments} "More comments" control(s)`,
        retryable: true,
        evidence: { clicks, stillCollapsed: pendingExpand, stillHasMoreComments: pendingMoreComments },
        rounds,
      };
    }

    const raw = await evalFileViaCdp(cdp, page('dom_extractor.js'), { __ACTION: 'extractCase' });
    if (!raw || !Array.isArray(raw.comments) || raw.comments.length === 0) {
      return { ok: false, stage: 'no-comments', reason: 'case extraction returned no comments' };
    }

    return {
      ok: true,
      noUpdate: false,
      raw,
      detailRaw,
      detailExtracted,
      detailSwitchError,
      clicks,
      rounds,
      pendingExpand,
      pendingMoreComments,
    };
  }

  async close() {
    if (this._ownsCdp && this.cdp && typeof this.cdp.close === 'function') {
      await this.cdp.close();
    }
    this.cdp = null;
  }
}
