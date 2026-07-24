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
import { after, before, describe, it } from 'node:test';

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
  const { stripComments, parseResult } = await import(new URL('browser.mjs', SCRIPTS));

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
    assert.equal(isNoUpdate({ anchorIdx: 0, displayed: 2, top: { author: 'Alice' } }, cached), true);
    assert.equal(isNoUpdate({ anchorIdx: 1, displayed: 3, top: { author: 'Carol' } }, cached), false);
    assert.equal(isNoUpdate({ anchorIdx: 0, displayed: 3, top: { author: 'Alice' } }, cached), false);
  });

  it('never lets a failed probe read as unchanged', () => {
    assert.equal(isNoUpdate(null, cached), false);
    assert.equal(isNoUpdate({ anchorIdx: -1, top: null }, cached), false);
  });

  it('maps blocked/auth statuses to distinct non-zero exits', () => {
    assert.equal(STATUS_EXIT['no-update'], 0);
    assert.equal(STATUS_EXIT['auth-required'], 3);
    assert.equal(STATUS_EXIT.blocked, 5);
  });
});

describe('enrich_local.mjs', async () => {
  const m = await import(new URL('enrich_local.mjs', SCRIPTS));

  it('extracts JSON from a fenced / chatty local-model reply', () => {
    assert.deepEqual(m.extractJson('Sure!\n```json\n{"summary":"x","role":"Analysis"}\n```'),
      { summary: 'x', role: 'Analysis' });
    assert.deepEqual(m.extractJson('{"a":"}{"}'), { a: '}{' });
    assert.equal(m.extractJson('no json here'), null);
  });

  it('coerces a loose analysis and rejects an empty one', () => {
    assert.deepEqual(m.normalizeAnalysis({ summary: ' s ', role: 'analysis', keyPoints: ['a', 2], answered: 'yes' }),
      { summary: 's', role: 'Analysis', keyPoints: ['a'], citations: [], answered: false });
    assert.equal(m.normalizeAnalysis({ role: 'Analysis' }), null);
    assert.equal(m.normalizeAnalysis(null), null);
    assert.equal(m.normalizeAnalysis({ summary: 'x', role: 'nonsense' }).role, 'Info');
  });

  it('defaults an unstated root cause to Unresolved', () => {
    assert.equal(m.normalizeCaseLevel({ engineerSummary: 'x' }).rootCause, 'Unresolved');
    assert.equal(m.normalizeCaseLevel({ currentStatus: 'x' }), null);
  });

  it('builds the case flow oldest-first, skipping unanalyzed comments', () => {
    const flow = m.buildCaseFlow(
      [{ id: 'c1', author: 'A' }, { id: 'c2', author: 'B' }],
      { c2: { role: 'Symptom', summary: 'first' } },
    );
    assert.equal(flow.length, 1);
    assert.deepEqual(flow[0], { step: 1, phase: 'Symptom', date: '', by: 'B', what: 'first', refComments: ['c2'] });
  });
});

describe('scheduler.mjs', async () => {
  const { dueCases } = await import(new URL('scheduler.mjs', SCRIPTS));
  const now = Date.parse('2026-07-01T12:00:00.000Z');
  const wl = { intervalMinutes: 60, cases: [
    { code: '1', }, { code: '2' }, { code: '3', enabled: false }, { code: '4', intervalMinutes: 600 },
  ] };
  const runs = {
    1: { lastRunAt: '2026-07-01T11:30:00.000Z' },   // 30m ago, not due
    2: { lastRunAt: '2026-07-01T10:00:00.000Z' },   // 2h ago, due
    4: { lastRunAt: '2026-07-01T10:00:00.000Z' },   // 2h ago but every 10h
  };

  it('selects only enabled cases past their own interval', () => {
    assert.deepEqual(dueCases(wl, runs, now).map(c => c.code), ['2']);
  });

  it('treats a never-run case as due', () => {
    assert.deepEqual(dueCases({ intervalMinutes: 60, cases: [{ code: '9' }] }, {}, now).map(c => c.code), ['9']);
  });
});

describe('web dashboard', async () => {
  const { createApp, projectCase } = await import(new URL('../web/server.mjs', import.meta.url));
  let server;
  before(() => new Promise(done => { server = createApp().listen(0, '127.0.0.1', done); }));
  after(() => server.close());
  const base = () => `http://127.0.0.1:${server.address().port}`;

  it('projects a case without dragging the comment bodies along', () => {
    const p = projectCase('08603854', { title: 't', comments: [{ author: 'A', timestamp: 'x', body: 'huge' }] }, null, null);
    assert.equal(p.commentCount, 1);
    assert.deepEqual(p.latestComment, { author: 'A', timestamp: 'x' });
    assert.ok(!JSON.stringify(p).includes('huge'));
  });

  it('serves the overview of the cached case', async () => {
    const d = await fetch(`${base()}/api/overview`).then(r => r.json());
    const c = d.cases.find(x => x.code === '08603854');
    assert.equal(c.title, 'NR SA attach failure');
    assert.equal(c.commentCount, 2);
    assert.equal(c.cached, true);
  });

  it('rejects a non-8-digit code on the watchlist', async () => {
    const r = await fetch(`${base()}/api/watchlist`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'add', code: '12' }),
    });
    assert.equal(r.status, 400);
  });

  it('refuses to serve a path outside the artifact whitelist', async () => {
    const r = await fetch(`${base()}/artifact/08603854/case.json`);
    assert.equal(r.status, 404);
  });
});
