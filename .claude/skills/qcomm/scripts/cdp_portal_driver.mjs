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
      let p = await evalFileViaCdp(cdp, page('dom_extractor.js'), { __ACTION: 'expandStep', __ANCHOR: anchor, __PROBE: true });
      for (let i = 0; i < FEED_PROBE_ROUNDS; i++) {
        const prevArticles = p ? p.articles : 0;
        await sleep(2000);
        p = await evalFileViaCdp(cdp, page('dom_extractor.js'), { __ACTION: 'expandStep', __ANCHOR: anchor, __PROBE: true });
        if (p && p.articles && p.articles === prevArticles) break;
      }
      return p;
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
    for (; rounds < EXPAND_ROUNDS; rounds++) {
      const r = await evalFileViaCdp(cdp, page('dom_extractor.js'), { __ACTION: 'expandStep', __ANCHOR: anchor });
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

    if (rounds >= EXPAND_ROUNDS && idleTicks < 2) {
      for (let grace = 0; grace < STUCK_RETRY_ROUNDS; grace++) {
        const r = await evalFileViaCdp(cdp, page('dom_extractor.js'), { __ACTION: 'expandStep', __ANCHOR: anchor });
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

    let confirmedZero = 0;
    for (let s = 0; s < SETTLE_ROUNDS; s++) {
      await sleep(1000);
      const unexpanded = await evalFileViaCdp(cdp, page('dom_extractor.js'), { __ACTION: 'checkCollapsed', __ANCHOR: anchor });
      const pending = (unexpanded?.stillCollapsed || 0) + (unexpanded?.stillHasMoreComments || 0);
      if (pending === 0) {
        confirmedZero++;
        if (confirmedZero >= 2) break;
      } else {
        confirmedZero = 0;
        const r = await evalFileViaCdp(cdp, page('dom_extractor.js'), { __ACTION: 'expandStep', __ANCHOR: anchor });
        clicks.expand += r.clickedExpand || 0;
        clicks.viewMore += r.clickedViewMore || 0;
        clicks.moreComments += r.clickedMoreComments || 0;
        clicks.description += r.clickedDescription || 0;
      }
    }

    let lastUnexpanded = await evalFileViaCdp(cdp, page('dom_extractor.js'), { __ACTION: 'checkCollapsed', __ANCHOR: anchor });
    const stubbornCount = (lastUnexpanded?.stillCollapsed || 0) + (lastUnexpanded?.stillHasMoreComments || 0);
    if (stubbornCount > 0) {
      const settleBudget = Math.min(POST_EXPAND_SETTLE_ROUNDS, stubbornCount * 3 + 6);
      let consecutiveClean = 0;
      for (let s = 0; s < settleBudget; s++) {
        const attempt = await evalFileViaCdp(cdp, page('dom_extractor.js'), { __ACTION: 'expandStep', __ANCHOR: anchor, __TRUSTED: true });
        clicks.expand += attempt.clickedExpand || 0;
        clicks.viewMore += attempt.clickedViewMore || 0;
        clicks.moreComments += attempt.clickedMoreComments || 0;
        clicks.description += attempt.clickedDescription || 0;
        await sleep(2000);
        lastUnexpanded = await evalFileViaCdp(cdp, page('dom_extractor.js'), { __ACTION: 'checkCollapsed', __ANCHOR: anchor });
        const remaining = (lastUnexpanded?.stillCollapsed || 0) + (lastUnexpanded?.stillHasMoreComments || 0);
        if (remaining === 0) {
          consecutiveClean++;
          if (consecutiveClean >= 2) break;
        } else {
          consecutiveClean = 0;
        }
      }
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
        await evalFileViaCdp(cdp, page('dom_extractor.js'), { __ACTION: 'expandStep', __ANCHOR: anchor });
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
