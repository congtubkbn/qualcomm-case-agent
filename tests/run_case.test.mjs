// Tests for run_case.mjs's browser-driving state machine (landOnCase / findCaseLink) —
// the part of the pipeline that decides whether we actually landed on the real
// case page or a Lightning stub. browser.mjs (evalFile/open/click/sleep) is
// mocked via node:test's module mocker so these run with NO real Chrome/CDP/
// network involved — they must never touch the live portal.
//     node --experimental-test-module-mocks --test tests/run_case.test.mjs
//
// IMPORTANT: mock.module's specifier must resolve to the exact same file://
// URL that run_case.mjs's own `./browser.mjs` import resolves to, or the mock
// silently fails to attach and the real module (real Chrome) runs instead.
// Always build it with `new URL(...)`, never a hand-typed path string.
//
// Each test uses `t.mock` (not the top-level `mock` import) — that tracker
// auto-restores when the test ends, which is required: mock.module() throws
// if the same specifier is re-mocked without an intervening restore. Each
// test also imports run_case.mjs via a uniquely-querystringed URL so it gets
// a fresh module evaluation bound to THAT test's mock, not a cached one from
// an earlier test.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// run() (unlike findCaseLink/landOnCase) reads/writes under DATA_DIR — pin it
// to an empty throwaway root so "no cached case" is deterministic, same as
// pipeline.test.mjs does for the same _paths.mjs singleton.
process.env.QUALCOMM_ROOT = mkdtempSync(join(tmpdir(), 'qc-run-'));

const SCRIPTS = new URL('../.claude/skills/qualcomm-case-agent/scripts/', import.meta.url);
const BROWSER_URL = new URL('browser.mjs', SCRIPTS);

function mockBrowser(t, evalFileQueue) {
  const evalFileCalls = [];
  const openCalls = [];
  const clickCalls = [];
  t.mock.module(BROWSER_URL, {
    exports: {
      click: (sel) => { clickCalls.push(sel); },
      open: (url) => { openCalls.push(url); },
      sleep: async () => {},
      ensureChrome: async () => {},
      pdf: () => {},
      BrowserError: class BrowserError extends Error {},
      evalFile: (path, vars) => {
        evalFileCalls.push({ path: path.split(/[\\/]/).pop(), vars });
        const next = evalFileQueue.shift();
        if (next === undefined) throw new Error('mockBrowser: evalFile queue exhausted');
        return next;
      },
    },
  });
  return { evalFileCalls, openCalls, clickCalls };
}

let seq = 0;
const importRunCase = () => import(new URL(`run_case.mjs?t=${++seq}`, SCRIPTS));

const STUB_HREF = 'https://support.qualcomm.com/s/case/Case/Default';
const REAL_HREF = 'https://support.qualcomm.com/s/case/500dK00000HZeVSQA1/some-title';

describe('STUB_PATH_RE', () => {
  it('matches the Lightning un-routed stub path, not a real SFID case path', async () => {
    const { STUB_PATH_RE } = await importRunCase();
    assert.equal(STUB_PATH_RE.test('/s/case/Case/Default'), true);
    assert.equal(STUB_PATH_RE.test('/s/case/Case/Default?x=1'), true);
    assert.equal(STUB_PATH_RE.test('/s/case/500dK00000HZeVSQA1/some-title'), false);
  });
});

describe('findCaseLink', () => {
  it('returns immediately when the row already has a resolved href and title', async (t) => {
    const { evalFileCalls } = mockBrowser(t, [
      { state: 'FOUND', href: REAL_HREF, fields: { title: 'NR SA attach failure' } },
    ]);
    const { findCaseLink } = await importRunCase();
    const link = await findCaseLink('08438355');
    assert.equal(link.href, REAL_HREF);
    assert.equal(evalFileCalls.length, 1, 'no polling needed once href+title are resolved');
  });

  it('polls while the row is still on the stub href / missing a title, then gives up', async (t) => {
    const { evalFileCalls } = mockBrowser(t, [
      { state: 'FOUND', href: STUB_HREF, fields: {} },
      { state: 'FOUND', href: STUB_HREF, fields: {} },
      { state: 'FOUND', href: STUB_HREF, fields: {} },
      { state: 'FOUND', href: STUB_HREF, fields: {} },
      { state: 'FOUND', href: STUB_HREF, fields: {} },
      { state: 'FOUND', href: STUB_HREF, fields: {} },
    ]);
    const { findCaseLink } = await importRunCase();
    const link = await findCaseLink('08438355');
    // 1 initial read + HREF_RESOLVE_ROUNDS(5) retries = 6 total reads.
    assert.equal(evalFileCalls.length, 6);
    assert.equal(link.href, STUB_HREF, 'gives up and returns whatever it last had');
  });

  it('keeps polling on a resolved href until the title also arrives', async (t) => {
    const { evalFileCalls } = mockBrowser(t, [
      { state: 'FOUND', href: STUB_HREF, fields: {} },               // stub + no title
      { state: 'FOUND', href: REAL_HREF, fields: {} },               // real href, still no title
      { state: 'FOUND', href: REAL_HREF, fields: { title: 't' } },   // both conditions clear
    ]);
    const { findCaseLink } = await importRunCase();
    const link = await findCaseLink('08438355');
    assert.equal(evalFileCalls.length, 3, 'a resolved href alone does not end the poll — title must resolve too');
    assert.equal(link.href, REAL_HREF);
    assert.equal(link.fields.title, 't');
  });
});

describe('landOnCase', () => {
  it('lands via direct nav once the row href resolves (no click needed)', async (t) => {
    const { openCalls, clickCalls } = mockBrowser(t, [
      { state: 'FOUND', href: REAL_HREF, fields: { title: 't' } }, // findCaseLink
      { state: 'READY' },                                          // pollReadiness after open()
      { state: 'ON_CASE', href: REAL_HREF },                       // confirm landing
    ]);
    const { landOnCase } = await importRunCase();
    const res = await landOnCase('08438355');
    assert.deepEqual(res, { state: 'OK', href: REAL_HREF });
    assert.deepEqual(openCalls, [REAL_HREF]);
    assert.equal(clickCalls.length, 0, 'a resolved href must not fall back to the click path');
  });

  it('short-circuits to auth-required if the session lapses mid-navigation', async (t) => {
    mockBrowser(t, [
      { state: 'FOUND', href: REAL_HREF, fields: { title: 't' } },
      { state: 'AUTH', url: 'https://account.qualcomm.com/login' },
    ]);
    const { landOnCase } = await importRunCase();
    const res = await landOnCase('08438355');
    assert.deepEqual(res, { state: 'AUTH', url: 'https://account.qualcomm.com/login' });
  });

  it('falls back to the trusted click when direct nav still lands on the stub', async (t) => {
    const { clickCalls } = mockBrowser(t, [
      { state: 'FOUND', href: STUB_HREF, fields: {} },  // findCaseLink: never resolves past stub
      { state: 'FOUND', href: STUB_HREF, fields: {} },
      { state: 'FOUND', href: STUB_HREF, fields: {} },
      { state: 'FOUND', href: STUB_HREF, fields: {} },
      { state: 'FOUND', href: STUB_HREF, fields: {} },
      { state: 'FOUND', href: STUB_HREF, fields: {} },  // 6 reads, gives up -> landOnCase skips open()
      { state: 'READY' },                                // readiness after click
      { state: 'ON_CASE', href: REAL_HREF },              // route settled
    ]);
    const { landOnCase } = await importRunCase();
    const res = await landOnCase('08438355');
    assert.deepEqual(res, { state: 'OK', href: REAL_HREF });
    assert.deepEqual(clickCalls, ["[data-cq-hit='1']"]);
  });

  it('retries once from a fresh search load, then reports STUB if navigation never routes', async (t) => {
    const stubFound = { state: 'FOUND', href: STUB_HREF, fields: {} };
    // Each ROUTE_SETTLE_ROUNDS tick reads readiness.js THEN find_case_link.js.
    const routeSettleRound = () => [{ state: 'READY' }, stubFound];
    mockBrowser(t, [
      ...Array.from({ length: 6 }, () => stubFound),      // attempt 0: findCaseLink gives up (stub)
      ...Array.from({ length: 6 }, routeSettleRound).flat(), // attempt 0: click fallback, 6 rounds, never routes
      { state: 'READY' },                                 // retry search: pollReadiness
      { state: 'NO_LINK' },                                // retry search: findCaseLink relink fails
    ]);
    const { landOnCase } = await importRunCase();
    const res = await landOnCase('08438355');
    assert.equal(res.state, 'STUB');
    assert.match(res.reason, /retry search exposed no case link/);
  });
});

describe('run() expand-loop stuck detection', () => {
  // Case 08503838 in the wild: 7 of 11 comments were persisted with a literal
  // trailing "Expand Post" — the click fired every tick (so the idle-break
  // never triggered) but never actually expanded the post, and the loop just
  // ran out its round budget and fell through to extraction silently. This
  // reproduces that with a fully mocked browser: expand_step.js reports a
  // click every single tick, forever.
  it('reports blocked+retryable instead of silently extracting a half-expanded feed', async (t) => {
    const stuckTick = { clickedExpand: 1, clickedViewMore: 0, clickedDescription: 0, remainingExpand: 0 };
    const stableFeed = { articles: 5, displayed: 5, anchorIdx: -1, top: { author: 'A', bodyStart: 'x' } };
    mockBrowser(t, [
      { state: 'READY' },                                          // pollReadiness (initial search)
      { state: 'FOUND', href: REAL_HREF, fields: { title: 't' } },  // findCaseLink (direct, in run())
      { state: 'FOUND', href: REAL_HREF, fields: { title: 't' } },  // findCaseLink (inside landOnCase)
      { state: 'READY' },                                          // pollReadiness (inside landOnCase)
      { state: 'ON_CASE', href: REAL_HREF },                        // confirm landing
      stableFeed, stableFeed,                                       // probeFeed: stable on first re-check
      ...Array.from({ length: 40 }, () => stuckTick),               // main expand loop: EXPAND_ROUNDS, never idles
      ...Array.from({ length: 5 }, () => stuckTick),                // STUCK_RETRY_ROUNDS grace: still stuck
    ]);
    const { run } = await importRunCase();
    const v = await run('08438355', { mode: 'auto', enrich: 'none', noPdf: true });
    assert.equal(v.status, 'blocked');
    assert.equal(v.retryable, true);
    assert.match(v.reason, /Expand Post/);
    assert.equal(v.expandRounds, 40);
  });

  it('recovers if the stuck control finally lets go during the grace retries', async (t) => {
    const stuckTick = { clickedExpand: 1, clickedViewMore: 0, clickedDescription: 0, remainingExpand: 0 };
    const idleTick = { clickedExpand: 0, clickedViewMore: 0, clickedDescription: 0, remainingExpand: 0 };
    const stableFeed = { articles: 5, displayed: 5, anchorIdx: -1, top: { author: 'A', bodyStart: 'x' } };
    const { evalFileCalls } = mockBrowser(t, [
      { state: 'READY' },
      { state: 'FOUND', href: REAL_HREF, fields: { title: 't' } },
      { state: 'FOUND', href: REAL_HREF, fields: { title: 't' } },
      { state: 'READY' },
      { state: 'ON_CASE', href: REAL_HREF },
      stableFeed, stableFeed,
      ...Array.from({ length: 40 }, () => stuckTick),  // exhausts the round budget
      idleTick,                                        // grace retry 1: finally converges
      { comments: [{ author: 'A', body: 'ok', timestamp: 't' }] }, // extract_case.js
    ]);
    // Normally intake() (CLI entry, bypassed when calling run() directly in
    // tests) creates this dir before PHASE 2's raw-file write needs it.
    mkdirSync(join(process.env.QUALCOMM_ROOT, 'data', 'cases', '08438355'), { recursive: true });
    const { run } = await importRunCase();
    const v = await run('08438355', { mode: 'auto', enrich: 'none', noPdf: true });
    // Recovered past the stuck check — it went on to actually extract and
    // finalize for real (scrape_case.mjs is a real child process here, not
    // mocked). The point of this test is only that it did NOT give up with
    // the stuck verdict once the grace retry saw the control finally idle.
    assert.ok(!(v.status === 'blocked' && v.retryable), 'must not report the stuck verdict once a grace retry goes idle');
    assert.ok(!/round budget/.test(v.reason || ''));
    const names = evalFileCalls.map(c => c.path);
    // 2 feed-probe reads (PROBE mode) + 40 round-budget ticks + exactly 1 grace retry.
    assert.equal(names.filter(n => n === 'expand_step.js').length, 43);
  });
});
