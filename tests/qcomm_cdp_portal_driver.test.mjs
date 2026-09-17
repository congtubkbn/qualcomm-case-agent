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
import { CdpPortalDriver, DETAIL_SWITCH_RETRIES, FEED_PROBE_ROUNDS } from '../.claude/skills/qcomm/scripts/cdp_portal_driver.mjs';

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
  return {
    evalFileCalls,
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
      sleep: async () => {},
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
