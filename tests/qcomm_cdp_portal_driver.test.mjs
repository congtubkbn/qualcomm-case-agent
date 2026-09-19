// Tests for CdpPortalDriver.connect()'s neutral-descriptor contract (issue: fix
// "Classify connection verdicts through the PortalDriver seam, not browser.mjs's
// error classes"). connect() must never let browser.mjs's BrowserError/
// PortConflictError escape — it catches them and returns the same
// { ok, stage, reason, detail? } shape expandAndExtract() already uses, so
// run_case.mjs never has to import or instanceof-check browser.mjs's error
// classes to build a verdict.
//
//     node --test tests/qcomm_cdp_portal_driver.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CdpPortalDriver, DETAIL_SWITCH_RETRIES, FEED_PROBE_ROUNDS, EXPAND_ROUNDS, STUCK_RETRY_ROUNDS, SETTLE_ROUNDS, POST_EXPAND_SETTLE_ROUNDS } from '../.claude/skills/qcomm/scripts/cdp_portal_driver.mjs';

// Builds a { browser } namespace stub for expandAndExtract() scenario tests —
// direct constructor injection (see connect()'s tests below), not
// t.mock.module: this file re-imports nothing per test, so the plain-object
// seam CdpPortalDriver's constructor already takes is enough. `handler(file,
// vars)` scripts evalFileViaCdp's response by `vars.__ACTION`
// ('switchTab' | 'expandStep' | 'checkCollapsed' | 'extractCase'); returning
// undefined throws. expandStep/checkCollapsed calls are uncaught in
// expandAndExtract(), so an unscripted response there fails the test loudly;
// switchTab calls are wrapped in try/catch there, so an unscripted switchTab
// is instead swallowed into a detailSwitchError/feedSwitchError string.
function scriptedBrowser(handler) {
  const evalFileCalls = [];
  const sleepCalls = [];
  return {
    evalFileCalls,
    sleepCalls,
    browser: {
      evalFileViaCdp: async (_cdp, path, vars) => {
        const file = path.split(/[\\/]/).pop();
        evalFileCalls.push({ path: file, vars });
        const res = handler(file, vars);
        if (res === undefined) {
          throw new Error(`scriptedBrowser: no response scripted for ${file} __ACTION=${vars?.__ACTION}`);
        }
        return res;
      },
      sleep: async (ms) => { sleepCalls.push(ms); },
      open: () => {},
    },
  };
}

class BrowserError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'BrowserError';
    this.detail = detail;
  }
}
class PortConflictError extends BrowserError {
  constructor(message, detail) {
    super(message, detail);
    this.name = 'PortConflictError';
  }
}

describe('CdpPortalDriver.connect()', () => {
  it('returns { ok: true } and isConnected() true on success', async () => {
    const cdp = { isConnected: () => true };
    const driver = new CdpPortalDriver({
      browser: {
        ensureChrome: async () => {},
        getCdpClient: async () => cdp,
      },
      fastLanding: {},
    });
    const result = await driver.connect();
    assert.deepEqual(result, { ok: true });
    assert.equal(driver.isConnected(), true);
  });

  it('returns { ok: false, stage: "port-conflict", reason, detail } when ensureChrome throws PortConflictError, without isConnected()', async () => {
    const driver = new CdpPortalDriver({
      browser: {
        ensureChrome: async () => {
          throw new PortConflictError('CDP port 9773 is held by a process that is not this project\'s Chrome', { port: 9773, commandLine: 'other.exe' });
        },
        getCdpClient: async () => { throw new Error('should not be called'); },
      },
      fastLanding: {},
    });
    const result = await driver.connect();
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'port-conflict');
    assert.equal(result.reason, 'CDP port 9773 is held by a process that is not this project\'s Chrome');
    assert.deepEqual(result.detail, { port: 9773, commandLine: 'other.exe' });
    assert.equal(driver.isConnected(), false);
  });

  it('returns { ok: false, stage: "blocked", reason } when ensureChrome throws a plain BrowserError', async () => {
    const driver = new CdpPortalDriver({
      browser: {
        ensureChrome: async () => { throw new BrowserError('no Chrome on CDP 9773 (profile X) — start it, then retry'); },
        getCdpClient: async () => { throw new Error('should not be called'); },
      },
      fastLanding: {},
    });
    const result = await driver.connect();
    assert.deepEqual(result, { ok: false, stage: 'blocked', reason: 'no Chrome on CDP 9773 (profile X) — start it, then retry' });
    assert.equal(driver.isConnected(), false);
  });

  it('returns { ok: false, stage: "blocked", reason: e.message } when getCdpClient() throws (ensureChrome succeeds)', async () => {
    const driver = new CdpPortalDriver({
      browser: {
        ensureChrome: async () => {},
        getCdpClient: async () => { throw new Error('WebSocket handshake failed'); },
      },
      fastLanding: {},
    });
    const result = await driver.connect();
    assert.deepEqual(result, { ok: false, stage: 'blocked', reason: 'WebSocket handshake failed' });
    assert.equal(driver.isConnected(), false);
  });

  it('returns { ok: true } without calling getCdpClient() when a cdp client was pre-injected', async () => {
    const cdp = { isConnected: () => true };
    let getCdpClientCalled = false;
    const driver = new CdpPortalDriver({
      cdp,
      browser: {
        ensureChrome: async () => {},
        getCdpClient: async () => { getCdpClientCalled = true; return cdp; },
      },
      fastLanding: {},
    });
    const result = await driver.connect();
    assert.deepEqual(result, { ok: true });
    assert.equal(getCdpClientCalled, false);
  });

  it('still surfaces a port-conflict even when a cdp client was pre-injected (ensureChrome always runs first)', async () => {
    const cdp = { isConnected: () => true };
    const driver = new CdpPortalDriver({
      cdp,
      browser: {
        ensureChrome: async () => { throw new PortConflictError('port held by another tool', { port: 9773 }); },
      },
      fastLanding: {},
    });
    const result = await driver.connect();
    assert.deepEqual(result, { ok: false, stage: 'port-conflict', reason: 'port held by another tool', detail: { port: 9773 } });
    assert.equal(driver.isConnected(), false);
  });
});

// Beyond the Detail-tab/Feed-switch loops under test, each scenario below has
// to script a full happy-path expand/settle/extract so expandAndExtract() can
// run to completion and hand back a result with detailExtracted on it — that
// field only appears on the final { ok: true, ... } return, not on any
// early-exit descriptor.
describe('CdpPortalDriver.expandAndExtract() — Detail-tab and Feed switch-back (#253)', () => {
  it('retries the Detail-tab switch+extract on failure and succeeds within DETAIL_SWITCH_RETRIES', async () => {
    let detailSwitchAttempts = 0;
    let feedSwitched = false;
    const { browser } = scriptedBrowser((file, vars) => {
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Detail') {
        detailSwitchAttempts++;
        return detailSwitchAttempts === 1
          ? { ok: false, reason: 'Detail tab not yet rendered' }
          : { ok: true };
      }
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Feed') {
        feedSwitched = true;
        return { ok: true };
      }
      if (vars.__ACTION === 'extractCase') {
        return feedSwitched ? { comments: [{ id: 'c1' }] } : { detail: 'lightning-metadata' };
      }
      if (vars.__ACTION === 'expandStep' && vars.__PROBE) return { articles: 2 };
      if (vars.__ACTION === 'expandStep') return { clickedExpand: 0, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
      if (vars.__ACTION === 'checkCollapsed') return { stillCollapsed: 0, stillHasMoreComments: 0 };
      return undefined;
    });
    const driver = new CdpPortalDriver({ browser, fastLanding: {} });

    const result = await driver.expandAndExtract({ anchor: 'a1' });

    assert.equal(result.ok, true);
    assert.equal(result.detailExtracted, true);
    assert.equal(result.detailSwitchError, null);
    assert.deepEqual(result.detailRaw, { detail: 'lightning-metadata' });
    assert.equal(detailSwitchAttempts, 2);
  });

  it('marks detailExtracted false but continues past a permanently failed Detail-tab switch (non-fatal)', async () => {
    let detailSwitchAttempts = 0;
    let feedSwitched = false;
    const { browser } = scriptedBrowser((file, vars) => {
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Detail') {
        detailSwitchAttempts++;
        return { ok: false, reason: 'Detail tab never became active' };
      }
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Feed') {
        feedSwitched = true;
        return { ok: true };
      }
      if (vars.__ACTION === 'extractCase') {
        // Every Detail switchTab attempt fails above, so this is only ever
        // the final Phase-2 extract — the Detail-tab extractCase never runs.
        return { comments: [{ id: 'c1' }] };
      }
      if (vars.__ACTION === 'expandStep' && vars.__PROBE) return { articles: 2 };
      if (vars.__ACTION === 'expandStep') return { clickedExpand: 0, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
      if (vars.__ACTION === 'checkCollapsed') return { stillCollapsed: 0, stillHasMoreComments: 0 };
      return undefined;
    });
    const driver = new CdpPortalDriver({ browser, fastLanding: {} });

    const result = await driver.expandAndExtract({ anchor: 'a1' });

    assert.equal(result.ok, true);
    assert.equal(result.detailExtracted, false);
    assert.equal(detailSwitchAttempts, DETAIL_SWITCH_RETRIES);
  });

  it('hard-stops with { ok:false, stage:"feed-switch", retryable:true } when every Feed switch-back attempt fails, without attempting extraction (case 08637663 regression shape)', async () => {
    let feedSwitchAttempts = 0;
    const { browser, evalFileCalls } = scriptedBrowser((file, vars) => {
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Detail') return { ok: true };
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Feed') {
        feedSwitchAttempts++;
        return { ok: false, reason: 'tab is labeled "Communication", not "Feed"' };
      }
      if (vars.__ACTION === 'extractCase') return { detail: 'lightning-metadata' }; // Detail-tab call only
      // expandStep/checkCollapsed are deliberately unscripted: the hard-stop
      // must return before any of the expand/extract phases are reached.
      return undefined;
    });
    const driver = new CdpPortalDriver({ browser, fastLanding: {} });

    const result = await driver.expandAndExtract({ anchor: 'a1' });

    assert.deepEqual(result, {
      ok: false,
      stage: 'feed-switch',
      reason: 'could not switch back to the Feed tab for extraction: tab is labeled "Communication", not "Feed"',
      retryable: true,
    });
    assert.equal(feedSwitchAttempts, DETAIL_SWITCH_RETRIES);
    const extractCalls = evalFileCalls.filter(c => c.vars.__ACTION === 'extractCase');
    assert.equal(extractCalls.length, 1); // the Detail-tab extraction only — never Phase-2
  });
});

// The fast path checked below sits right after the feed-probe loop but isn't
// itself one of the six "phases" #253's architecture review named — it was
// surfaced during grilling as an equally-untested branch that decides whether
// expandAndExtract()'s eight remaining code sections run at all.
describe('CdpPortalDriver.expandAndExtract() — feed probe + onProbe fast path (#256)', () => {
  it('stabilizes the feed-probe loop (article count stops changing) well before FEED_PROBE_ROUNDS, then continues', async () => {
    let feedSwitched = false;
    let probeCalls = 0;
    let probeCallsAtDecision = null;
    const { browser } = scriptedBrowser((file, vars) => {
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Detail') return { ok: true };
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Feed') { feedSwitched = true; return { ok: true }; }
      if (vars.__ACTION === 'extractCase') return feedSwitched ? { comments: [{ id: 'c1' }] } : { detail: 'lightning-metadata' };
      if (vars.__ACTION === 'expandStep' && vars.__PROBE) {
        probeCalls++;
        // Before onProbe fires: 2 -> 4 -> 4 (stabilizes on the 3rd call).
        // After onProbe fires (article-count settle phase, later in the
        // function): stays at 4 so that phase also settles immediately.
        if (probeCallsAtDecision === null) return { articles: probeCalls === 1 ? 2 : 4 };
        return { articles: 4 };
      }
      if (vars.__ACTION === 'expandStep') return { clickedExpand: 0, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
      if (vars.__ACTION === 'checkCollapsed') return { stillCollapsed: 0, stillHasMoreComments: 0 };
      return undefined;
    });
    const driver = new CdpPortalDriver({ browser, fastLanding: {} });

    const result = await driver.expandAndExtract({
      anchor: 'a1',
      onProbe: probe => {
        probeCallsAtDecision = probeCalls;
        assert.equal(probe.articles, 4); // the stabilized count is what reaches the caller
        return false; // let the happy path continue past the fast path
      },
    });

    assert.equal(result.ok, true);
    assert.equal(probeCallsAtDecision, 3); // initial probe + 2 loop rounds, not FEED_PROBE_ROUNDS
    assert.ok(probeCallsAtDecision < FEED_PROBE_ROUNDS + 1);
  });

  it('reopens the case page via caseUrl and retries after an empty first probe, succeeding on the second attempt', async () => {
    let feedSwitched = false;
    let reopenCalls = 0;
    const cdp = { navigate: async () => { reopenCalls++; } };
    const { browser } = scriptedBrowser((file, vars) => {
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Detail') return { ok: true };
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Feed') { feedSwitched = true; return { ok: true }; }
      if (vars.__ACTION === 'extractCase') return feedSwitched ? { comments: [{ id: 'c1' }] } : { detail: 'lightning-metadata' };
      if (vars.__ACTION === 'expandStep' && vars.__PROBE) {
        // First probeFeed() (before reopen): always empty, exhausts every round.
        // Second probeFeed() (after reopen): stabilizes right away.
        return reopenCalls === 0 ? { articles: 0 } : { articles: 5 };
      }
      if (vars.__ACTION === 'expandStep') return { clickedExpand: 0, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
      if (vars.__ACTION === 'checkCollapsed') return { stillCollapsed: 0, stillHasMoreComments: 0 };
      return undefined;
    });
    const driver = new CdpPortalDriver({ cdp, browser, fastLanding: {} });

    const result = await driver.expandAndExtract({ anchor: 'a1', caseUrl: 'https://example.com/case/1' });

    assert.equal(result.ok, true);
    assert.equal(reopenCalls, 1);
  });

  it('returns { ok:false, stage:"no-articles", probe } when the feed probe stays empty and there is no caseUrl to retry', async () => {
    let feedSwitched = false;
    const { browser } = scriptedBrowser((file, vars) => {
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Detail') return { ok: true };
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Feed') { feedSwitched = true; return { ok: true }; }
      if (vars.__ACTION === 'extractCase') return { detail: 'lightning-metadata' }; // Detail-tab only; hard-stops before Phase 2
      if (vars.__ACTION === 'expandStep' && vars.__PROBE) return { articles: 0 };
      return undefined;
    });
    const driver = new CdpPortalDriver({ browser, fastLanding: {} });

    const result = await driver.expandAndExtract({ anchor: 'a1' });

    assert.deepEqual(result, {
      ok: false,
      stage: 'no-articles',
      reason: 'case page has no Chatter feed articles — wrong page or feed never loaded',
      probe: { articles: 0 },
    });
  });

  it('returns { ok:false, stage:"no-articles", probe } when a caseUrl reopen also comes back empty', async () => {
    let feedSwitched = false;
    let reopenCalls = 0;
    const cdp = { navigate: async () => { reopenCalls++; } };
    const { browser } = scriptedBrowser((file, vars) => {
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Detail') return { ok: true };
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Feed') { feedSwitched = true; return { ok: true }; }
      if (vars.__ACTION === 'extractCase') return { detail: 'lightning-metadata' };
      if (vars.__ACTION === 'expandStep' && vars.__PROBE) return { articles: 0 };
      return undefined;
    });
    const driver = new CdpPortalDriver({ cdp, browser, fastLanding: {} });

    const result = await driver.expandAndExtract({ anchor: 'a1', caseUrl: 'https://example.com/case/1' });

    assert.deepEqual(result, {
      ok: false,
      stage: 'no-articles',
      reason: 'case page has no Chatter feed articles — wrong page or feed never loaded',
      probe: { articles: 0 },
    });
    assert.equal(reopenCalls, 1);
  });

  it('returns { ok:true, noUpdate:true, probe } immediately when onProbe returns true, firing none of the expand/settle/trusted-click/final-extract calls', async () => {
    let feedSwitched = false;
    const { browser, evalFileCalls } = scriptedBrowser((file, vars) => {
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Detail') return { ok: true };
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Feed') { feedSwitched = true; return { ok: true }; }
      if (vars.__ACTION === 'extractCase') return { detail: 'lightning-metadata' }; // Detail-tab only
      if (vars.__ACTION === 'expandStep' && vars.__PROBE) return { articles: 7 };
      // expandStep (non-probe), checkCollapsed: deliberately unscripted —
      // the fast path must return before any of them ever fire.
      return undefined;
    });
    const driver = new CdpPortalDriver({ browser, fastLanding: {} });

    const result = await driver.expandAndExtract({ anchor: 'a1', onProbe: probe => probe.articles === 7 });

    assert.deepEqual(result, { ok: true, noUpdate: true, probe: { articles: 7 } });
    const expandCalls = evalFileCalls.filter(c => c.vars.__ACTION === 'expandStep' && !c.vars.__PROBE);
    const checkCollapsedCalls = evalFileCalls.filter(c => c.vars.__ACTION === 'checkCollapsed');
    const extractCalls = evalFileCalls.filter(c => c.vars.__ACTION === 'extractCase');
    const trustedCalls = evalFileCalls.filter(c => c.vars.__TRUSTED);
    assert.equal(expandCalls.length, 0);
    assert.equal(checkCollapsedCalls.length, 0);
    assert.equal(trustedCalls.length, 0);
    assert.equal(extractCalls.length, 1); // the Detail-tab extraction only — Phase 2's final extraction never runs
  });
});

// Every scenario below scripts checkCollapsed to always report zero pending so
// the settle loop / trusted-click fallback / final gate all fall straight
// through to a successful extraction — the point of these tests is the expand
// loop (EXPAND_ROUNDS) and the grace-retry loop (STUCK_RETRY_ROUNDS) that
// follows it, not the phases after. Each scripted plain (non-probe,
// non-trusted) expandStep response is keyed off a running call counter, since
// the same __ACTION also fires once more, harmlessly, in the article-count
// settle phase after the code under test.
describe('CdpPortalDriver.expandAndExtract() — expand loop + grace-retry recovery (#257)', () => {
  it("accumulateClicks() sums each expandStep response's click fields onto the running tally, defaulting a missing field to 0 rather than resetting the others (#273)", async () => {
    let feedSwitched = false;
    let plainCalls = 0;
    const { browser } = scriptedBrowser((file, vars) => {
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Detail') return { ok: true };
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Feed') { feedSwitched = true; return { ok: true }; }
      if (vars.__ACTION === 'extractCase') return feedSwitched ? { comments: [{ id: 'c1' }] } : { detail: 'lightning-metadata' };
      if (vars.__ACTION === 'expandStep' && vars.__PROBE) return { articles: 4 };
      if (vars.__ACTION === 'expandStep') {
        plainCalls++;
        // Tick 1: clicks two different fields. Tick 2: clicks a third field
        // and omits the others entirely (not just zero) — accumulateClicks
        // must still add tick 1's totals rather than overwrite them. Tick 3+:
        // idle, breaking the loop; the article-count settle phase's single
        // trailing call also reports idle, so the tally stays put.
        if (plainCalls === 1) return { clickedExpand: 2, clickedMoreComments: 1 };
        if (plainCalls === 2) return { clickedViewMore: 1 };
        return { clickedExpand: 0, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
      }
      if (vars.__ACTION === 'checkCollapsed') return { stillCollapsed: 0, stillHasMoreComments: 0 };
      return undefined;
    });
    const driver = new CdpPortalDriver({ browser, fastLanding: {} });

    const result = await driver.expandAndExtract({ anchor: 'a1' });

    assert.equal(result.ok, true);
    assert.deepEqual(result.clicks, { expand: 2, viewMore: 1, moreComments: 1, description: 0 });
  });

  it('breaks the expand loop at two consecutive idle ticks well before EXPAND_ROUNDS, never entering the grace-retry loop', async () => {
    let feedSwitched = false;
    let plainCalls = 0;
    const { browser, evalFileCalls } = scriptedBrowser((file, vars) => {
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Detail') return { ok: true };
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Feed') { feedSwitched = true; return { ok: true }; }
      if (vars.__ACTION === 'extractCase') return feedSwitched ? { comments: [{ id: 'c1' }] } : { detail: 'lightning-metadata' };
      if (vars.__ACTION === 'expandStep' && vars.__PROBE) return { articles: 4 };
      if (vars.__ACTION === 'expandStep') {
        plainCalls++;
        // Ticks 1-2 click; ticks 3-4 go idle (two consecutive), tripping the
        // idle break at round index 3 — the 5th call is the article-count
        // settle phase's single stabilizing click, well after the loop under test.
        if (plainCalls <= 2) return { clickedExpand: 1, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
        return { clickedExpand: 0, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
      }
      if (vars.__ACTION === 'checkCollapsed') return { stillCollapsed: 0, stillHasMoreComments: 0 };
      return undefined;
    });
    const driver = new CdpPortalDriver({ browser, fastLanding: {} });

    const result = await driver.expandAndExtract({ anchor: 'a1' });

    assert.equal(result.ok, true);
    assert.equal(result.rounds, 3); // loop stopped at the idle break, not EXPAND_ROUNDS - 1
    assert.ok(result.rounds < EXPAND_ROUNDS);
    assert.deepEqual(result.clicks, { expand: 2, viewMore: 0, moreComments: 0, description: 0 }); // only the first two ticks clicked
    const expandLoopCalls = evalFileCalls.filter(c => c.vars.__ACTION === 'expandStep' && !c.vars.__PROBE);
    assert.equal(expandLoopCalls.length, 5); // 4 in the expand loop + 1 in article-count settle — grace-retry never ran
  });

  it('sleeps 1500ms after an active tick but skips the sleep on the tick that reaches the 2-consecutive-idle break (repeatUntilStable migration must not add a sleep the raw loop never had)', async () => {
    let feedSwitched = false;
    let plainCalls = 0;
    const { browser, sleepCalls } = scriptedBrowser((file, vars) => {
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Detail') return { ok: true };
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Feed') { feedSwitched = true; return { ok: true }; }
      if (vars.__ACTION === 'extractCase') return feedSwitched ? { comments: [{ id: 'c1' }] } : { detail: 'lightning-metadata' };
      if (vars.__ACTION === 'expandStep' && vars.__PROBE) return { articles: 4 };
      if (vars.__ACTION === 'expandStep') {
        plainCalls++;
        // Same click pattern as the test above: ticks 1-2 click, ticks 3-4
        // idle (two consecutive), breaking the loop at tick 4.
        if (plainCalls <= 2) return { clickedExpand: 1, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
        return { clickedExpand: 0, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
      }
      if (vars.__ACTION === 'checkCollapsed') return { stillCollapsed: 0, stillHasMoreComments: 0 };
      return undefined;
    });
    const driver = new CdpPortalDriver({ browser, fastLanding: {} });

    await driver.expandAndExtract({ anchor: 'a1' });

    // Full sequence, deterministic given this scenario's scripted responses:
    // - Pre-loop: Detail-switch success (1000), the unconditional
    //   post-feed-switch sleep (500), the feed probe stabilizing (2000).
    // - Main expand loop (repeatUntilStable, sleepMs:0 -> a 0ms sleep
    //   between every non-terminating tick, interleaved with each tick's
    //   own idle/active sleep): tick 1 (click) -> 1500 + 0, tick 2 (click)
    //   -> 1500 + 0, tick 3 (1st idle) -> 1000 + 0, tick 4 (2nd consecutive
    //   idle, reaches stableTarget and returns immediately) -> NO sleep at
    //   all — exactly like the raw for-loop's `if (idleTicks >= 2) break;`
    //   before its `await sleep(1000)`. Migrating to repeatUntilStable must
    //   not add a sleep the raw loop never had on that terminating tick.
    // - confirmedZero settle loop: two clean rounds -> 1000, 1000.
    // - article-count-settle loop: round 1 (count differs from -1) -> 2000,
    //   round 2 (matches, count 2 of 3) -> 2000, round 3 (matches >= 3,
    //   breaks before its own sleep).
    assert.deepEqual(sleepCalls, [
      1000, 500, 2000,
      1500, 0, 1500, 0, 1000, 0,
      1000, 1000,
      2000, 2000,
    ]);
  });

  it('exhausts the full EXPAND_ROUNDS budget while clicking every tick, then starts the grace-retry loop', async () => {
    let feedSwitched = false;
    let plainCalls = 0;
    let postBudgetCalls = 0; // every plain expandStep call once EXPAND_ROUNDS is spent
    const { browser, evalFileCalls } = scriptedBrowser((file, vars) => {
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Detail') return { ok: true };
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Feed') { feedSwitched = true; return { ok: true }; }
      if (vars.__ACTION === 'extractCase') return feedSwitched ? { comments: [{ id: 'c1' }] } : { detail: 'lightning-metadata' };
      if (vars.__ACTION === 'expandStep' && vars.__PROBE) return { articles: 4 };
      if (vars.__ACTION === 'expandStep') {
        plainCalls++;
        // Every one of the EXPAND_ROUNDS expand-loop ticks clicks, so
        // idleTicks never reaches 2 — the loop only exits when the round
        // budget runs out. Call EXPAND_ROUNDS+1 is the grace-retry loop's
        // first tick (idle, so grace lets go immediately); the next call is
        // article-count settle's single stabilizing click.
        if (plainCalls <= EXPAND_ROUNDS) return { clickedExpand: 1, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
        postBudgetCalls++;
        return { clickedExpand: 0, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
      }
      if (vars.__ACTION === 'checkCollapsed') return { stillCollapsed: 0, stillHasMoreComments: 0 };
      return undefined;
    });
    const driver = new CdpPortalDriver({ browser, fastLanding: {} });

    const result = await driver.expandAndExtract({ anchor: 'a1' });

    assert.equal(result.ok, true);
    assert.equal(result.rounds, EXPAND_ROUNDS); // exited on budget exhaustion, not an idle break
    assert.equal(result.clicks.expand, EXPAND_ROUNDS); // only the expand-loop ticks clicked
    // article-count settle always contributes exactly one trailing plain
    // expandStep call (see the #257 describe-block comment), so subtracting
    // it isolates the grace-retry loop's own tick count: 1, proving the loop
    // started and immediately let go on its first round.
    assert.equal(postBudgetCalls, 2);
    assert.equal(postBudgetCalls - 1, 1);
  });

  it('lets a stuck grace-retry loop go once clicking stops partway through STUCK_RETRY_ROUNDS, proceeding to settle instead of failing', async () => {
    const GRACE_CLICKING_ROUNDS = 2; // clicks through 2 grace rounds, then stops — short of STUCK_RETRY_ROUNDS
    assert.ok(GRACE_CLICKING_ROUNDS < STUCK_RETRY_ROUNDS);
    let feedSwitched = false;
    let plainCalls = 0;
    let postBudgetCalls = 0; // every plain expandStep call once EXPAND_ROUNDS is spent
    const { browser, evalFileCalls } = scriptedBrowser((file, vars) => {
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Detail') return { ok: true };
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Feed') { feedSwitched = true; return { ok: true }; }
      if (vars.__ACTION === 'extractCase') return feedSwitched ? { comments: [{ id: 'c1' }] } : { detail: 'lightning-metadata' };
      if (vars.__ACTION === 'expandStep' && vars.__PROBE) return { articles: 4 };
      if (vars.__ACTION === 'expandStep') {
        plainCalls++;
        if (plainCalls <= EXPAND_ROUNDS) return { clickedExpand: 1, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
        postBudgetCalls++;
        const graceTick = plainCalls - EXPAND_ROUNDS;
        if (graceTick <= GRACE_CLICKING_ROUNDS) return { clickedExpand: 1, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
        return { clickedExpand: 0, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 }; // lets go — grace loop breaks here
      }
      if (vars.__ACTION === 'checkCollapsed') return { stillCollapsed: 0, stillHasMoreComments: 0 };
      return undefined;
    });
    const driver = new CdpPortalDriver({ browser, fastLanding: {} });

    const result = await driver.expandAndExtract({ anchor: 'a1' });

    assert.equal(result.ok, true); // proceeds through settle -> final gate -> extract, no premature stuck-expand failure
    assert.equal(result.clicks.expand, EXPAND_ROUNDS + GRACE_CLICKING_ROUNDS);
    // article-count settle always contributes exactly one trailing plain
    // expandStep call (see the #257 describe-block comment), so subtracting
    // it isolates the grace-retry loop's own tick count: GRACE_CLICKING_ROUNDS
    // clicks + 1 idle tick that breaks it — short of STUCK_RETRY_ROUNDS.
    assert.equal(postBudgetCalls - 1, GRACE_CLICKING_ROUNDS + 1);
    const checkCollapsedCalls = evalFileCalls.filter(c => c.vars.__ACTION === 'checkCollapsed');
    assert.ok(checkCollapsedCalls.length > 0); // settle phase and final gate actually ran
  });
});

// checkCollapsed fires in up to four places: the settle loop itself (once per
// round), the fallback's pre-check ("lastUnexpanded", deciding stubbornCount),
// inside the fallback loop (once per round), and the final pre-extraction
// gate. Each scenario below drives it with a call counter and documents the
// call-index -> phase mapping inline. Plain (non-probe, non-trusted)
// expandStep calls are disambiguated the same way: the expand loop above this
// code always ticks twice with all-zero clicks (idle-break, uninteresting
// here), and a settle-loop retry returns clickedViewMore:1 so
// result.clicks.viewMore isolates it. The trailing article-count-settle call
// (which always fires exactly once after the fallback, per the #257
// describe-block comment) also returns clickedDescription:1 in these
// scenarios but that isn't asserted here — see #259's "count-stabilize loop"
// test for coverage of that call's clicks now folding into `clicks` (#273).
describe('CdpPortalDriver.expandAndExtract() — settle loop + trusted-click fallback (#258)', () => {
  it('retries expandStep when the settle loop finds pending posts, then re-checks rather than exiting immediately', async () => {
    let feedSwitched = false;
    let checkCollapsedCalls = 0;
    let plainCalls = 0;
    const { browser, evalFileCalls } = scriptedBrowser((file, vars) => {
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Detail') return { ok: true };
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Feed') { feedSwitched = true; return { ok: true }; }
      if (vars.__ACTION === 'extractCase') return feedSwitched ? { comments: [{ id: 'c1' }] } : { detail: 'lightning-metadata' };
      if (vars.__ACTION === 'expandStep' && vars.__PROBE) return { articles: 4 };
      if (vars.__ACTION === 'expandStep' && vars.__TRUSTED) throw new Error('trusted fallback should never run — lastUnexpanded reports zero stubborn posts');
      if (vars.__ACTION === 'expandStep') {
        plainCalls++;
        // 1-2: expand loop (idle-break). 3: settle-loop retry (s=0, pending).
        // 4: article-count-settle's trailing call.
        if (plainCalls <= 2) return { clickedExpand: 0, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
        if (plainCalls === 3) return { clickedExpand: 0, clickedViewMore: 1, clickedMoreComments: 0, clickedDescription: 0 };
        return { clickedExpand: 0, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 1 };
      }
      if (vars.__ACTION === 'checkCollapsed') {
        checkCollapsedCalls++;
        // 1: settle s=0, pending -> retry. 2-3: settle s=1,2, clean twice ->
        // break. 4: lastUnexpanded, clean -> stubbornCount 0, fallback skipped.
        // 5: final gate, clean -> proceeds to extract.
        if (checkCollapsedCalls === 1) return { stillCollapsed: 1, stillHasMoreComments: 0 };
        return { stillCollapsed: 0, stillHasMoreComments: 0 };
      }
      return undefined;
    });
    const driver = new CdpPortalDriver({ browser, fastLanding: {} });

    const result = await driver.expandAndExtract({ anchor: 'a1' });

    assert.equal(result.ok, true);
    assert.equal(result.clicks.viewMore, 1); // exactly one settle-loop retry fired
    // The article-count-settle phase's own trailing expandStep call (driver
    // source: cdp_portal_driver.mjs ~line 296) never aggregates its result
    // into `clicks` — so its occurrence is only observable via evalFileCalls,
    // not via result.clicks.
    const plainExpandCalls = evalFileCalls.filter(c => c.vars.__ACTION === 'expandStep' && !c.vars.__PROBE && !c.vars.__TRUSTED);
    assert.equal(plainExpandCalls.length, 4); // 2 expand-loop idle ticks + 1 settle retry + 1 article-count-settle trailing call
    const trustedCalls = evalFileCalls.filter(c => c.vars.__ACTION === 'expandStep' && c.vars.__TRUSTED);
    assert.equal(trustedCalls.length, 0); // fallback never entered
    assert.equal(checkCollapsedCalls, 5);
    const settleLoopChecks = checkCollapsedCalls - 2; // minus lastUnexpanded and the final gate
    assert.equal(settleLoopChecks, 3);
    assert.ok(settleLoopChecks < SETTLE_ROUNDS);
  });

  it('confirms zero pending twice consecutively and exits the settle loop well before exhausting SETTLE_ROUNDS', async () => {
    let feedSwitched = false;
    let checkCollapsedCalls = 0;
    let plainCalls = 0;
    const { browser, evalFileCalls } = scriptedBrowser((file, vars) => {
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Detail') return { ok: true };
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Feed') { feedSwitched = true; return { ok: true }; }
      if (vars.__ACTION === 'extractCase') return feedSwitched ? { comments: [{ id: 'c1' }] } : { detail: 'lightning-metadata' };
      if (vars.__ACTION === 'expandStep' && vars.__PROBE) return { articles: 4 };
      if (vars.__ACTION === 'expandStep' && vars.__TRUSTED) throw new Error('trusted fallback should never run — lastUnexpanded reports zero stubborn posts');
      if (vars.__ACTION === 'expandStep') {
        plainCalls++;
        // 1-2: expand loop (idle-break). 3: article-count-settle's trailing
        // call — no settle-loop retries this time.
        if (plainCalls <= 2) return { clickedExpand: 0, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
        return { clickedExpand: 0, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 1 };
      }
      if (vars.__ACTION === 'checkCollapsed') {
        checkCollapsedCalls++;
        // 1-2: settle s=0,1, clean both times -> confirmedZero reaches 2,
        // break. 3: lastUnexpanded, clean -> fallback skipped. 4: final gate.
        return { stillCollapsed: 0, stillHasMoreComments: 0 };
      }
      return undefined;
    });
    const driver = new CdpPortalDriver({ browser, fastLanding: {} });

    const result = await driver.expandAndExtract({ anchor: 'a1' });

    assert.equal(result.ok, true);
    assert.equal(result.clicks.viewMore, 0); // no retries needed
    const trustedCalls = evalFileCalls.filter(c => c.vars.__ACTION === 'expandStep' && c.vars.__TRUSTED);
    assert.equal(trustedCalls.length, 0);
    assert.equal(checkCollapsedCalls, 4);
    const settleLoopChecks = checkCollapsedCalls - 2;
    assert.equal(settleLoopChecks, 2);
    assert.ok(settleLoopChecks < SETTLE_ROUNDS);
  });

  it('drives the trusted-click fallback through stubborn collapsed posts and asserts every expandStep call in this phase carries __TRUSTED:true', async () => {
    let feedSwitched = false;
    let checkCollapsedCalls = 0;
    let plainCalls = 0;
    let trustedRoundCalls = 0;
    const { browser, evalFileCalls } = scriptedBrowser((file, vars) => {
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Detail') return { ok: true };
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Feed') { feedSwitched = true; return { ok: true }; }
      if (vars.__ACTION === 'extractCase') return feedSwitched ? { comments: [{ id: 'c1' }] } : { detail: 'lightning-metadata' };
      if (vars.__ACTION === 'expandStep' && vars.__PROBE) return { articles: 4 };
      if (vars.__ACTION === 'expandStep' && vars.__TRUSTED) {
        trustedRoundCalls++;
        return { clickedExpand: 1, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
      }
      if (vars.__ACTION === 'expandStep') {
        plainCalls++;
        // 1-2: expand loop (idle-break). 3: article-count-settle's trailing
        // call — settle loop below is clean immediately, no retries.
        if (plainCalls <= 2) return { clickedExpand: 0, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
        return { clickedExpand: 0, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 1 };
      }
      if (vars.__ACTION === 'checkCollapsed') {
        checkCollapsedCalls++;
        // 1-2: settle loop, clean both times -> break early.
        if (checkCollapsedCalls <= 2) return { stillCollapsed: 0, stillHasMoreComments: 0 };
        // 3: lastUnexpanded -> stubbornCount 1 -> settleBudget = min(15, 9) = 9.
        if (checkCollapsedCalls === 3) return { stillCollapsed: 1, stillHasMoreComments: 0 };
        // 4-5: fallback rounds 1-2, still stubborn (consecutiveClean stays 0).
        // 6-7: fallback rounds 3-4, clean -> consecutiveClean reaches 2, break.
        if (checkCollapsedCalls <= 5) return { stillCollapsed: 1, stillHasMoreComments: 0 };
        if (checkCollapsedCalls <= 7) return { stillCollapsed: 0, stillHasMoreComments: 0 };
        // 8: final gate, clean -> proceeds to extract.
        return { stillCollapsed: 0, stillHasMoreComments: 0 };
      }
      return undefined;
    });
    const driver = new CdpPortalDriver({ browser, fastLanding: {} });

    const result = await driver.expandAndExtract({ anchor: 'a1' });

    assert.equal(result.ok, true);
    const trustedCalls = evalFileCalls.filter(c => c.vars.__ACTION === 'expandStep' && c.vars.__TRUSTED);
    assert.equal(trustedCalls.length, 4); // 4 fallback rounds before the consecutiveClean>=2 break
    assert.equal(trustedRoundCalls, 4);
    assert.ok(trustedCalls.every(c => c.vars.__TRUSTED === true && !c.vars.__PROBE && c.vars.__ANCHOR === 'a1'));
    assert.equal(result.clicks.expand, 4); // cross-check: only the fallback contributed to clicks.expand
    assert.equal(result.clicks.viewMore, 0);
  });

  it('computes the fallback round budget as Math.min(POST_EXPAND_SETTLE_ROUNDS, stubbornCount * 3 + 6) and exhausts it when posts never clear', async () => {
    const stubbornCount = 1; // min(15, 9) = 9 — proves the formula, not just the POST_EXPAND_SETTLE_ROUNDS ceiling
    const expectedBudget = Math.min(POST_EXPAND_SETTLE_ROUNDS, stubbornCount * 3 + 6);
    assert.equal(expectedBudget, 9);
    let feedSwitched = false;
    let checkCollapsedCalls = 0;
    let plainCalls = 0;
    let trustedRoundCalls = 0;
    const { browser, evalFileCalls } = scriptedBrowser((file, vars) => {
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Detail') return { ok: true };
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Feed') { feedSwitched = true; return { ok: true }; }
      if (vars.__ACTION === 'extractCase') return feedSwitched ? { comments: [{ id: 'c1' }] } : { detail: 'lightning-metadata' };
      if (vars.__ACTION === 'expandStep' && vars.__PROBE) return { articles: 4 };
      if (vars.__ACTION === 'expandStep' && vars.__TRUSTED) {
        trustedRoundCalls++;
        return { clickedExpand: 1, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
      }
      if (vars.__ACTION === 'expandStep') {
        plainCalls++;
        if (plainCalls <= 2) return { clickedExpand: 0, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
        return { clickedExpand: 0, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 1 };
      }
      if (vars.__ACTION === 'checkCollapsed') {
        checkCollapsedCalls++;
        // 1-2: settle loop, clean -> break early.
        if (checkCollapsedCalls <= 2) return { stillCollapsed: 0, stillHasMoreComments: 0 };
        // 3: lastUnexpanded -> stubbornCount 1 -> settleBudget 9.
        // 4-12 (9 rounds): fallback never clears -> exhausts the full budget.
        // 13: final gate, still stuck -> stuck-expand.
        return { stillCollapsed: stubbornCount, stillHasMoreComments: 0 };
      }
      return undefined;
    });
    const driver = new CdpPortalDriver({ browser, fastLanding: {} });

    const result = await driver.expandAndExtract({ anchor: 'a1' });

    assert.equal(result.ok, false);
    assert.equal(result.stage, 'stuck-expand');
    const trustedCalls = evalFileCalls.filter(c => c.vars.__ACTION === 'expandStep' && c.vars.__TRUSTED);
    assert.equal(trustedCalls.length, expectedBudget);
    assert.equal(trustedRoundCalls, expectedBudget);
    assert.equal(result.evidence.clicks.expand, expectedBudget);
    assert.equal(result.evidence.stillCollapsed, stubbornCount);
  });

  it('exits the fallback early via the consecutiveClean >= 2 break rather than exhausting its settle budget', async () => {
    const stubbornCount = 2; // settleBudget = min(15, 12) = 12
    const settleBudget = Math.min(POST_EXPAND_SETTLE_ROUNDS, stubbornCount * 3 + 6);
    assert.equal(settleBudget, 12);
    let feedSwitched = false;
    let checkCollapsedCalls = 0;
    let plainCalls = 0;
    let trustedRoundCalls = 0;
    const { browser, evalFileCalls } = scriptedBrowser((file, vars) => {
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Detail') return { ok: true };
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Feed') { feedSwitched = true; return { ok: true }; }
      if (vars.__ACTION === 'extractCase') return feedSwitched ? { comments: [{ id: 'c1' }] } : { detail: 'lightning-metadata' };
      if (vars.__ACTION === 'expandStep' && vars.__PROBE) return { articles: 4 };
      if (vars.__ACTION === 'expandStep' && vars.__TRUSTED) {
        trustedRoundCalls++;
        return { clickedExpand: 1, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
      }
      if (vars.__ACTION === 'expandStep') {
        plainCalls++;
        if (plainCalls <= 2) return { clickedExpand: 0, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
        return { clickedExpand: 0, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 1 };
      }
      if (vars.__ACTION === 'checkCollapsed') {
        checkCollapsedCalls++;
        // 1-2: settle loop, clean -> break early.
        if (checkCollapsedCalls <= 2) return { stillCollapsed: 0, stillHasMoreComments: 0 };
        // 3: lastUnexpanded -> stubbornCount 2 -> settleBudget 12.
        if (checkCollapsedCalls === 3) return { stillCollapsed: stubbornCount, stillHasMoreComments: 0 };
        // 4-5: fallback rounds 1-2, both clean immediately -> consecutiveClean
        // reaches 2, breaks after only 2 of the 12 available rounds.
        // 6: final gate, clean -> proceeds to extract.
        return { stillCollapsed: 0, stillHasMoreComments: 0 };
      }
      return undefined;
    });
    const driver = new CdpPortalDriver({ browser, fastLanding: {} });

    const result = await driver.expandAndExtract({ anchor: 'a1' });

    assert.equal(result.ok, true);
    const trustedCalls = evalFileCalls.filter(c => c.vars.__ACTION === 'expandStep' && c.vars.__TRUSTED);
    assert.equal(trustedCalls.length, 2);
    assert.equal(trustedRoundCalls, 2);
    assert.ok(trustedCalls.length < settleBudget); // exited early, not by budget exhaustion
    assert.equal(result.clicks.expand, 2);
  });
});

// Covers the last section of expandAndExtract(): the article-count-gate
// settle loop (SETTLE_ROUNDS, second occurrence), the final pre-extraction
// gate, and the Phase-2 extraction call that follows it. Every scenario
// scripts the settle loop / trusted-click fallback (already covered by #258)
// to fall straight through clean, so only the code under test drives the
// outcome. Since #273, the count-stabilize loop's non-probe expandStep call
// routes through the shared accumulateClicks() helper like every other
// expand-loop call site, so its clicks now reach result.clicks too.
describe('CdpPortalDriver.expandAndExtract() — article-count gate + final extraction gate (#259)', () => {
  it('stabilizes the article-count-settle loop after three consecutive matching counts, then proceeds to the final gate', async () => {
    let feedSwitched = false;
    let probeCalls = 0;
    let checkCollapsedCalls = 0;
    const { browser, evalFileCalls } = scriptedBrowser((file, vars) => {
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Detail') return { ok: true };
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Feed') { feedSwitched = true; return { ok: true }; }
      if (vars.__ACTION === 'extractCase') return feedSwitched ? { comments: [{ id: 'c1' }] } : { detail: 'lightning-metadata' };
      if (vars.__ACTION === 'expandStep' && vars.__PROBE) {
        probeCalls++;
        // Calls 1-2: initial feed probe, stabilizes immediately at 4 articles.
        // Calls 3-5: article-count-settle loop — steady at 4 the whole time,
        // so s=0 sets prevCount and s=1,2 match it, breaking via matches>=3
        // well before SETTLE_ROUNDS.
        return { articles: 4 };
      }
      if (vars.__ACTION === 'expandStep') return { clickedExpand: 0, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
      if (vars.__ACTION === 'checkCollapsed') {
        checkCollapsedCalls++;
        return { stillCollapsed: 0, stillHasMoreComments: 0 };
      }
      return undefined;
    });
    const driver = new CdpPortalDriver({ browser, fastLanding: {} });

    const result = await driver.expandAndExtract({ anchor: 'a1' });

    assert.equal(result.ok, true);
    const articleSettleProbeCalls = probeCalls - 2; // minus the initial feed-probe's 2 calls
    assert.equal(articleSettleProbeCalls, 3);
    assert.ok(articleSettleProbeCalls < SETTLE_ROUNDS);
    // settle loop (2, clean->break) + lastUnexpanded (1, clean->fallback skipped) + final gate (1)
    assert.equal(checkCollapsedCalls, 4);
    const extractCalls = evalFileCalls.filter(c => c.vars.__ACTION === 'extractCase');
    assert.equal(extractCalls.length, 2); // Detail-tab extraction + the final Phase-2 extraction
  });

  it('folds a click reported by the count-stabilize loop\'s non-probe expandStep call into result.clicks instead of dropping it (#273)', async () => {
    let feedSwitched = false;
    let plainCalls = 0;
    const { browser } = scriptedBrowser((file, vars) => {
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Detail') return { ok: true };
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Feed') { feedSwitched = true; return { ok: true }; }
      if (vars.__ACTION === 'extractCase') return feedSwitched ? { comments: [{ id: 'c1' }] } : { detail: 'lightning-metadata' };
      if (vars.__ACTION === 'expandStep' && vars.__PROBE) return { articles: 4 };
      if (vars.__ACTION === 'expandStep') {
        plainCalls++;
        // Calls 1-2: main expand loop, idle both ticks -> breaks immediately.
        // Call 3: the count-stabilize loop's first round, where prevCount
        // starts at -1 and mismatches the probed count, firing the one
        // non-probe expandStep under test here.
        if (plainCalls <= 2) return { clickedExpand: 0, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
        return { clickedExpand: 1, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
      }
      if (vars.__ACTION === 'checkCollapsed') return { stillCollapsed: 0, stillHasMoreComments: 0 };
      return undefined;
    });
    const driver = new CdpPortalDriver({ browser, fastLanding: {} });

    const result = await driver.expandAndExtract({ anchor: 'a1' });

    assert.equal(result.ok, true);
    // Before #273 this click was discarded (the loop awaited the call but
    // never folded its result into `clicks`) — now it must show up here.
    assert.equal(result.clicks.expand, 1);
  });

  it('extracts successfully when the final gate finds zero pending items', async () => {
    let feedSwitched = false;
    const { browser, evalFileCalls } = scriptedBrowser((file, vars) => {
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Detail') return { ok: true };
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Feed') { feedSwitched = true; return { ok: true }; }
      if (vars.__ACTION === 'extractCase') return feedSwitched ? { comments: [{ id: 'c1' }, { id: 'c2' }] } : { detail: 'lightning-metadata' };
      if (vars.__ACTION === 'expandStep' && vars.__PROBE) return { articles: 4 };
      if (vars.__ACTION === 'expandStep') return { clickedExpand: 0, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
      if (vars.__ACTION === 'checkCollapsed') return { stillCollapsed: 0, stillHasMoreComments: 0 };
      return undefined;
    });
    const driver = new CdpPortalDriver({ browser, fastLanding: {} });

    const result = await driver.expandAndExtract({ anchor: 'a1' });

    assert.equal(result.ok, true);
    assert.equal(result.noUpdate, false);
    assert.deepEqual(result.raw, { comments: [{ id: 'c1' }, { id: 'c2' }] });
    assert.equal(result.pendingExpand, 0);
    assert.equal(result.pendingMoreComments, 0);
    const extractCalls = evalFileCalls.filter(c => c.vars.__ACTION === 'extractCase');
    assert.equal(extractCalls.length, 2); // Detail-tab extraction + the final Phase-2 extraction
  });

  it('fails with stuck-expand when the final gate still finds pending items, without ever calling Phase-2 extractCase', async () => {
    let feedSwitched = false;
    let checkCollapsedCalls = 0;
    const { browser, evalFileCalls } = scriptedBrowser((file, vars) => {
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Detail') return { ok: true };
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Feed') { feedSwitched = true; return { ok: true }; }
      if (vars.__ACTION === 'extractCase') return { detail: 'lightning-metadata' }; // Detail-tab only; final gate hard-stops before Phase 2
      if (vars.__ACTION === 'expandStep' && vars.__PROBE) return { articles: 4 };
      if (vars.__ACTION === 'expandStep') return { clickedExpand: 0, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
      if (vars.__ACTION === 'checkCollapsed') {
        checkCollapsedCalls++;
        // 1-2: settle loop, clean -> break early. 3: lastUnexpanded, clean ->
        // fallback skipped. 4: final gate, still pending -> stuck-expand.
        if (checkCollapsedCalls <= 3) return { stillCollapsed: 0, stillHasMoreComments: 0 };
        return { stillCollapsed: 2, stillHasMoreComments: 1 };
      }
      return undefined;
    });
    const driver = new CdpPortalDriver({ browser, fastLanding: {} });

    const result = await driver.expandAndExtract({ anchor: 'a1' });

    assert.equal(result.ok, false);
    assert.equal(result.stage, 'stuck-expand');
    assert.equal(result.reason, 'expand loop left 2 collapsed post(s) and 1 "More comments" control(s)');
    assert.equal(result.retryable, true);
    assert.deepEqual(result.evidence.clicks, { expand: 0, viewMore: 0, moreComments: 0, description: 0 });
    assert.equal(result.evidence.stillCollapsed, 2);
    assert.equal(result.evidence.stillHasMoreComments, 1);
    assert.ok(Number.isInteger(result.rounds));
    const extractCalls = evalFileCalls.filter(c => c.vars.__ACTION === 'extractCase');
    assert.equal(extractCalls.length, 1); // Detail-tab extraction only — Phase 2 never runs
  });

  it('returns { ok:false, stage:"no-comments" } when the final gate is clean but Phase-2 extraction comes back empty', async () => {
    let feedSwitched = false;
    const { browser, evalFileCalls } = scriptedBrowser((file, vars) => {
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Detail') return { ok: true };
      if (vars.__ACTION === 'switchTab' && vars.__TARGET_TAB === 'Feed') { feedSwitched = true; return { ok: true }; }
      if (vars.__ACTION === 'extractCase') return feedSwitched ? { comments: [] } : { detail: 'lightning-metadata' };
      if (vars.__ACTION === 'expandStep' && vars.__PROBE) return { articles: 4 };
      if (vars.__ACTION === 'expandStep') return { clickedExpand: 0, clickedViewMore: 0, clickedMoreComments: 0, clickedDescription: 0 };
      if (vars.__ACTION === 'checkCollapsed') return { stillCollapsed: 0, stillHasMoreComments: 0 };
      return undefined;
    });
    const driver = new CdpPortalDriver({ browser, fastLanding: {} });

    const result = await driver.expandAndExtract({ anchor: 'a1' });

    assert.deepEqual(result, { ok: false, stage: 'no-comments', reason: 'case extraction returned no comments' });
    const extractCalls = evalFileCalls.filter(c => c.vars.__ACTION === 'extractCase');
    assert.equal(extractCalls.length, 2); // Detail-tab extraction + the final Phase-2 attempt
  });
});
