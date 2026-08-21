// Unit tests for the headless pipeline's pure logic + a dashboard smoke test.
//     node --test tests/
//
// _paths.mjs reads QUALCOMM_ROOT once, at first evaluation, and ESM caches the
// module — so ONE fixture root is set here at load time and every module below
// is pulled in with a dynamic import that resolves against it.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SCRIPTS = new URL('../.claude/skills/qualcomm-case-agent/scripts/', import.meta.url);

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'qc-'));
  mkdirSync(join(root, 'data', 'cases', '08603854'), { recursive: true });
  writeFileSync(join(root, 'data', 'cases', '_index.json'), JSON.stringify({
    '08603854': { syncedAt: '2026-07-01T00:00:00.000Z', commentCount: 2, hash: 'abc' },
  }));
  writeFileSync(join(root, 'data', 'cases', '08603854', 'case.json'), JSON.stringify({
    caseNumber: '08603854', title: 'NR SA attach failure', status: 'Open', priority: 'P2',
    displayedCommentCount: 2, hash: 'abc', extractedAt: '2026-07-01T00:00:00.000Z',
    comments: [
      { id: 'c1', author: 'Alice', timestamp: '2 days ago', body: '  RRC   reject seen on band n78 ' },
      { id: 'c2', author: 'Bob', timestamp: '5 days ago', body: 'Initial report' },
    ],
    enrichment: { engineerSummary: 'UE fails SA attach.', commentAnalyses: { c1: { summary: 's', role: 'Analysis' } } },
  }));
  return root;
}

process.env.QUALCOMM_ROOT = fixtureRoot();

describe('browser.mjs', async () => {
  const { stripComments, parseResult, buildPayload } = await import(new URL('browser.mjs', SCRIPTS));

  // P0 regression. Page scripts read their parameters as `typeof __X !== 'undefined'`.
  // Injected as top-level `var`s, those became PAGE GLOBALS that outlived the
  // call: once probeFeed ran one `__PROBE: true` tick, every later expand tick
  // still saw __PROBE === true, returned at the probe short-circuit and clicked
  // NOTHING — for the rest of the run, silently, reported as "nothing left to
  // expand". Indirect eval here reproduces the CDP Runtime.evaluate scope
  // exactly (global), so the leak is real if it comes back.
  it('scopes injected vars to the call — never leaks them into the page', () => {
    const probe = '(function(){ return (typeof __PROBE !== "undefined") ? __PROBE : "absent"; })()';
    assert.equal((0, eval)(buildPayload(probe, { __PROBE: true })), true);
    assert.equal((0, eval)(buildPayload(probe, {})), 'absent');
    assert.equal(typeof globalThis.__PROBE, 'undefined');
  });

  it('passes each var through as a real value, not a string', () => {
    const src = '(function(){ return __ANCHOR.bodyStart; })()';
    assert.equal((0, eval)(buildPayload(src, { __ANCHOR: { bodyStart: 'RRC reject' } })), 'RRC reject');
  });

  it('strips comment lines but keeps code containing //-like text', () => {
    const src = '// header\n\nvar u = "a[href*=\\"/s/case/\\"]";\n// tail\nreturn u;';
    const out = stripComments(src);
    assert.ok(!out.includes('header'));
    assert.ok(out.includes('/s/case/'));
    assert.equal(out.split('\n').length, 2);
  });

  it('parses the last JSON line of noisy CLI output', () => {
    assert.deepEqual(parseResult('connecting…\n{"state":"READY","rows":3}'), { state: 'READY', rows: 3 });
    assert.deepEqual(parseResult('{\n  "a": 1\n}'), { a: 1 });
    assert.equal(parseResult('plain text'), 'plain text');
  });
});

describe('run_case.mjs', async () => {
  const { anchorOf, isNoUpdate, STATUS_EXIT } = await import(new URL('run_case.mjs', SCRIPTS));
  const cached = { comments: [{ author: 'Alice', body: '  RRC   reject seen ' }], displayedCommentCount: 2 };

  it('normalizes whitespace into the anchor body prefix', () => {
    assert.deepEqual(anchorOf(cached), { author: 'Alice', bodyStart: 'RRC reject seen' });
    assert.equal(anchorOf({ comments: [] }), null);
  });

  it('reports no-update only when the anchor is still the top post', () => {
    assert.equal(isNoUpdate({ anchorIdx: 0, pendingExpand: 0, pendingMoreComments: 0, top: { author: 'Alice' } }, cached), true);
    assert.equal(isNoUpdate({ anchorIdx: 1, pendingExpand: 0, pendingMoreComments: 0, top: { author: 'Carol' } }, cached), false);
  });

  // The probe clicks nothing, so an unexpanded control is unread content: a new
  // nested reply lives behind "More comments" under an OLD post and never moves
  // the top post (case 08503838). Unread content => inconclusive, not unchanged.
  it('refuses to call a feed unchanged while anything is still unexpanded', () => {
    assert.equal(isNoUpdate({ anchorIdx: 0, pendingExpand: 0, pendingMoreComments: 1, top: { author: 'Alice' } }, cached), false);
    assert.equal(isNoUpdate({ anchorIdx: 0, pendingExpand: 2, pendingMoreComments: 0, top: { author: 'Alice' } }, cached), false);
  });

  it('never lets a failed probe read as unchanged', () => {
    assert.equal(isNoUpdate(null, cached), false);
    assert.equal(isNoUpdate({ anchorIdx: -1, top: null }, cached), false);
    // A probe that predates the pending-control counters cannot prove anything.
    assert.equal(isNoUpdate({ anchorIdx: 0, top: { author: 'Alice' } }, cached), false);
  });

  it('maps blocked/auth/busy statuses to distinct non-zero exits', () => {
    assert.equal(STATUS_EXIT['no-update'], 0);
    assert.equal(STATUS_EXIT['auth-required'], 3);
    assert.equal(STATUS_EXIT.blocked, 5);
    assert.equal(STATUS_EXIT.busy, 6);
  });
});

describe('lock.mjs', async () => {
  const { acquireLock, releaseLock } = await import(new URL('lock.mjs', SCRIPTS));
  const lockPath = join(mkdtempSync(join(tmpdir(), 'qc-lock-')), 'capture.lock');

  it('grants, then refuses while held, then grants after release', () => {
    assert.equal(acquireLock(lockPath).ok, true);
    const second = acquireLock(lockPath);
    assert.equal(second.ok, false);
    assert.equal(second.holder.pid, process.pid);
    releaseLock(lockPath);
    assert.equal(acquireLock(lockPath).ok, true);
    releaseLock(lockPath);
  });

  it('takes over a stale lock (dead pid or expired timestamp)', () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 30, at: new Date().toISOString() }));
    assert.equal(acquireLock(lockPath).ok, true, 'dead pid = stale');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: '2020-01-01T00:00:00.000Z' }));
    assert.equal(acquireLock(lockPath).ok, true, 'old timestamp = stale');
    writeFileSync(lockPath, 'not json');
    assert.equal(acquireLock(lockPath).ok, true, 'corrupt lock = stale');
    releaseLock(lockPath);
  });
});

