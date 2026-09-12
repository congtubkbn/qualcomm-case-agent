// Tests for qcomm's orchestrator (prepare/finalize).
// deps.mjs (captureCase) is mocked via node:test's module mocker so no test makes a
// real subprocess/browser call. Summarization itself is not mocked here because it is
// not a script-side effect: prepare() hands the model-input package to the calling
// agent, and finalize() takes the agent's already-produced comments/flow as input.
//     node --experimental-test-module-mocks --test tests/qcomm_summary_orchestrator.test.mjs

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import child_process from 'node:child_process';
import { promisify } from 'node:util';

process.env.QUALCOMM_ROOT = mkdtempSync(join(tmpdir(), 'qc-summary-'));

const SCRIPTS = new URL('../.claude/skills/qcomm/scripts/', import.meta.url);

function mockDeps(t, captureResult) {
  const captureCalls = [];
  const mockExec = (file, args, cb) => {};
  mockExec[promisify.custom] = async (file, args) => {
    const code = args[1];
    captureCalls.push(code);
    const result = typeof captureResult === 'function' ? captureResult(code) : captureResult;
    const stdout = JSON.stringify(result) + '\n';
    
    const exitCode = result.status === 'created' || result.status === 'updated' || result.status === 'no-update' ? 0 : 3;
    if (exitCode === 0) {
      return { stdout, stderr: '' };
    } else {
      const err = new Error(`Command failed`);
      err.code = exitCode;
      err.stdout = stdout;
      throw err;
    }
  };

  t.mock.module('node:child_process', {
    exports: {
      ...child_process,
      execFile: mockExec,
    },
  });

  return { captureCalls };
}

let seq = 0;
const importOrchestrator = () => import(new URL(`run_summary.mjs?t=${++seq}`, SCRIPTS));

function caseDir(code) {
  const d = join(process.env.QUALCOMM_ROOT, 'data', 'cases', code);
  mkdirSync(d, { recursive: true });
  return d;
}

function writeCaseJson(code, { comments, status = 'Open' }) {
  writeFileSync(
    join(caseDir(code), 'case.json'),
    JSON.stringify({ caseNumber: code, status, comments }, null, 2),
  );
}

function writeSummaryJson(code, summary) {
  writeFileSync(join(caseDir(code), 'summary.json'), JSON.stringify(summary, null, 2));
}

describe('prepare()', () => {
  it('first-ever run: no summary.json yet -> delta is every comment', async (t) => {
    mockDeps(t, { status: 'created' });
    writeCaseJson('08000010', {
      comments: [
        { id: 'c1', timestamp: 't1', author: 'A', body: 'first' },
        { id: 'c2', timestamp: 't2', author: 'B', body: 'second' },
      ],
    });
    const { prepare } = await importOrchestrator();
    const result = await prepare('08000010');
    assert.equal(result.status, 'needs-summary');
    assert.equal(result.deltaComments.length, 2);
    assert.deepEqual(result.deltaComments.map((c) => c.id), ['c1', 'c2']);
    assert.equal(result.priorFlow, '');
    assert.equal(result.caseStatus, 'Open');
  });

  it('unchanged re-run: no-update verdict and empty delta -> returns cached summary, no summarization requested', async (t) => {
    mockDeps(t, { status: 'no-update' });
    writeCaseJson('08000011', {
      status: 'Pending Qualcomm',
      comments: [{ id: 'c1', timestamp: 't1', author: 'A', body: 'first' }],
    });
    const priorSummary = {
      caseNumber: '08000011',
      status: 'Pending Qualcomm',
      summarizedCommentIds: ['c1'],
      comments: [{ id: 'c1', issue: 'x', nextAction: 'wait' }],
      flow: 'Nothing new yet.',
      lastSummarizedAt: '2026-08-20T00:00:00.000Z',
    };
    writeSummaryJson('08000011', priorSummary);

    const { prepare } = await importOrchestrator();
    const result = await prepare('08000011');
    assert.equal(result.status, 'no-delta');
    assert.deepEqual(result.summary, priorSummary);
    assert.equal(result.deltaComments, undefined);
  });

  it('no-delta run reports the case\'s current status verbatim, even when stale in the cached summary', async (t) => {
    mockDeps(t, { status: 'no-update' });
    writeCaseJson('08000014', {
      status: 'Closed',
      comments: [{ id: 'c1', timestamp: 't1', author: 'A', body: 'first' }],
    });
    writeSummaryJson('08000014', {
      caseNumber: '08000014',
      status: 'Pending Qualcomm',
      summarizedCommentIds: ['c1'],
      comments: [{ id: 'c1', issue: 'x', nextAction: 'wait' }],
      flow: 'Nothing new yet.',
      lastSummarizedAt: '2026-08-20T00:00:00.000Z',
    });

    const { prepare } = await importOrchestrator();
    const result = await prepare('08000014');
    assert.equal(result.status, 'no-delta');
    assert.equal(result.caseStatus, 'Closed');
    assert.equal(result.summary.status, 'Pending Qualcomm');
  });

  it('no-delta run does not rewrite summary.json/summary.md on disk', async (t) => {
    mockDeps(t, { status: 'no-update' });
    writeCaseJson('08000015', {
      status: 'Closed',
      comments: [{ id: 'c1', timestamp: 't1', author: 'A', body: 'first' }],
    });
    writeSummaryJson('08000015', {
      caseNumber: '08000015',
      status: 'Pending Qualcomm',
      summarizedCommentIds: ['c1'],
      comments: [{ id: 'c1', issue: 'x', nextAction: 'wait' }],
      flow: 'Nothing new yet.',
      lastSummarizedAt: '2026-08-20T00:00:00.000Z',
    });
    const mdPath = join(caseDir('08000015'), 'summary.md');
    writeFileSync(mdPath, 'ORIGINAL MD CONTENT');
    const jsonPath = join(caseDir('08000015'), 'summary.json');
    const jsonBefore = readFileSync(jsonPath, 'utf8');

    const { prepare } = await importOrchestrator();
    await prepare('08000015');

    assert.equal(readFileSync(jsonPath, 'utf8'), jsonBefore);
    assert.equal(readFileSync(mdPath, 'utf8'), 'ORIGINAL MD CONTENT');
  });

  it('update run: delta is only the new comment ids, prior summaries untouched in the input', async (t) => {
    mockDeps(t, { status: 'updated' });
    writeCaseJson('08000012', {
      comments: [
        { id: 'c1', timestamp: 't1', author: 'A', body: 'first' },
        { id: 'c2', timestamp: 't2', author: 'B', body: 'second' },
        { id: 'c3', timestamp: 't3', author: 'C', body: 'third' },
      ],
    });
    writeSummaryJson('08000012', {
      caseNumber: '08000012',
      status: 'Open',
      summarizedCommentIds: ['c1', 'c2'],
      comments: [
        { id: 'c1', issue: 'x' },
        { id: 'c2', issue: 'y' },
      ],
      flow: 'So far: x then y.',
      lastSummarizedAt: '2026-08-20T00:00:00.000Z',
    });

    const { prepare } = await importOrchestrator();
    const result = await prepare('08000012');
    assert.equal(result.status, 'needs-summary');
    assert.deepEqual(result.deltaComments.map((c) => c.id), ['c3']);
    assert.equal(result.priorFlow, 'So far: x then y.');
  });

  it('applies the character cap to delta comment bodies before returning them', async (t) => {
    mockDeps(t, { status: 'created' });
    const oversized = 'z'.repeat(20500);
    writeCaseJson('08000013', {
      comments: [{ id: 'c1', timestamp: 't1', author: 'A', body: oversized }],
    });
    const { prepare } = await importOrchestrator();
    const result = await prepare('08000013');
    assert.equal(result.deltaComments[0].body.length, 20000);
  });

  it('prepare() sorts delta comments chronologically ascending (oldest-first)', async (t) => {
    mockDeps(t, { status: 'created' });
    writeCaseJson('08000030', {
      comments: [
        { id: 'c3', timestamp: '2026-08-23T10:00:00.000Z', author: 'C', body: 'reply' },
        { id: 'c2', timestamp: '2026-08-23T09:00:00.000Z', author: 'B', body: 'second' },
        { id: 'c1', timestamp: '2026-08-23T08:00:00.000Z', author: 'A', body: 'first' },
      ],
    });
    const { prepare } = await importOrchestrator();
    const result = await prepare('08000030');
    assert.equal(result.status, 'needs-summary');
    assert.deepEqual(result.deltaComments.map((c) => c.id), ['c1', 'c2', 'c3']);
  });

  for (const status of ['auth-required', 'not-found', 'blocked', 'busy', 'error']) {
    it(`capture-failure passthrough: ${status} surfaces as-is without attempting summarization`, async (t) => {
      mockDeps(t, { status, reason: `synthetic ${status}` });
      const { prepare } = await importOrchestrator();
      const result = await prepare('08000099');
      assert.equal(result.status, status);
      assert.equal(result.capture.reason, `synthetic ${status}`);
      assert.equal(result.deltaComments, undefined);
    });
  }
});

describe('finalize()', () => {
  it('merges the agent-produced summaries into summary.json and renders summary.md', async (t) => {
    mockDeps(t, { status: 'created' });
    writeCaseJson('08000020', {
      status: 'Open',
      comments: [{ id: 'c1', timestamp: 't1', author: 'A', body: 'first' }],
    });
    const { finalize } = await importOrchestrator();
    const result = finalize('08000020', {
      comments: [{ id: 'c1', timestamp: 't1', author: 'A', issue: 'x', nextAction: 'wait' }],
      flow: 'Customer reported x.',
    });
    assert.equal(result.status, 'summarized');
    assert.ok(existsSync(result.summaryPath));
    assert.ok(existsSync(result.mdPath));

    const written = JSON.parse(readFileSync(result.summaryPath, 'utf8'));
    assert.deepEqual(written.summarizedCommentIds, ['c1']);
    assert.equal(written.status, 'Open');

    const md = readFileSync(result.mdPath, 'utf8');
    assert.match(md, /Customer reported x\./);
  });

  it('update run: reads prior summary.json off disk, preserves its comments untouched, appends the new batch (oldest-first, nested)', async (t) => {
    mockDeps(t, { status: 'updated' });
    writeCaseJson('08000021', {
      status: 'Pending Qualcomm',
      comments: [
        { id: 'c1', timestamp: 't1', author: 'A', body: 'first' },
        { id: 'c2', timestamp: 't2', author: 'B', body: 'second' },
        { id: 'c3', timestamp: 't3', author: 'C', body: 'third' },
      ],
    });
    const priorC1 = { id: 'c1', timestamp: 't1', author: 'A', issue: 'x', status: 'FAIL', subs: [] };
    const priorC2 = { id: 'c2', timestamp: 't2', author: 'B', nextAction: 'wait for logs', subs: [] };
    writeSummaryJson('08000021', {
      caseNumber: '08000021',
      status: 'Open',
      summarizedCommentIds: ['c1', 'c2'],
      // oldest-first, nested tree: A (t1) is older than B (t2), per #233's ordering rule.
      comments: [priorC1, priorC2],
      flow: 'A reported x (FAIL); B said wait for logs.',
      lastSummarizedAt: '2026-08-20T00:00:00.000Z',
    });

    const { finalize } = await importOrchestrator();
    const result = finalize('08000021', {
      comments: [{ id: 'c3', timestamp: 't3', author: 'C', nextAction: 'escalate' }],
      flow: 'A reported x (FAIL); B said wait for logs; C escalated.',
    });

    const written = JSON.parse(readFileSync(result.summaryPath, 'utf8'));
    assert.deepEqual(written.summarizedCommentIds, ['c1', 'c2', 'c3']);
    assert.deepEqual(written.comments[0], priorC1);
    assert.deepEqual(written.comments[1], priorC2);
    assert.deepEqual(written.comments[2], { id: 'c3', timestamp: 't3', author: 'C', nextAction: 'escalate', subs: [] });
    assert.equal(written.flow, 'A reported x (FAIL); B said wait for logs; C escalated.');
    assert.equal(written.status, 'Pending Qualcomm');

    const md = readFileSync(result.mdPath, 'utf8');
    const c1Idx = md.indexOf('### 1. A (t1)');
    const c2Idx = md.indexOf('### 2. B (t2)');
    const c3Idx = md.indexOf('### 3. C (t3)');
    assert.ok(c1Idx < c2Idx && c2Idx < c3Idx, 'oldest comment (c1) must render above newer ones, in hierarchical order');
  });

  it('migrates a legacy flat summary.json (newest-batch-first, no subs) into a nested, oldest-first tree while merging a new reply', async (t) => {
    mockDeps(t, { status: 'updated' });
    // case.json (post-#233) is the source of truth for order and parentage: c1 is
    // oldest, with replies c2 and (soon) c4 nested under it; c3 is an unrelated,
    // later top-level post.
    writeCaseJson('08000025', {
      status: 'Pending Qualcomm',
      comments: [
        {
          id: 'c1', timestamp: 't1', author: 'A', body: 'first', subs: [
            { id: 'c2', timestamp: 't2', author: 'B', body: 'reply to first', subs: [] },
            { id: 'c4', timestamp: 't4', author: 'D', body: 'another reply to first', subs: [] },
          ],
        },
        { id: 'c3', timestamp: 't3', author: 'C', body: 'unrelated later post', subs: [] },
      ],
    });
    // Legacy pre-#235 summary.json: flat, no subs, and stored newest-batch-first
    // (c3's batch was finalized after c1/c2's, so old finalize() prepended it).
    writeSummaryJson('08000025', {
      caseNumber: '08000025',
      status: 'Open',
      summarizedCommentIds: ['c1', 'c2', 'c3'],
      comments: [
        { id: 'c3', issue: 'unrelated later post' },
        { id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait' },
        { id: 'c2', issue: 'x follow-up', nextAction: 'wait more' },
      ],
      flow: 'Customer reported x; followed up; unrelated later post.',
      lastSummarizedAt: '2026-08-20T00:00:00.000Z',
    });

    const { finalize } = await importOrchestrator();
    const result = finalize('08000025', {
      // c4 is already in case.json's tree (captured, per mockDeps('updated')) but not
      // yet summarized -- this is the agent-produced digest for it.
      comments: [{ id: 'c4', issue: 'x follow-up 2' }],
      flow: 'Customer reported x; followed up; unrelated later post; followed up again.',
    });
    assert.equal(result.status, 'summarized');

    const written = JSON.parse(readFileSync(result.summaryPath, 'utf8'));
    assert.deepEqual(written.comments, [
      { id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait', subs: [
        { id: 'c2', issue: 'x follow-up', nextAction: 'wait more', subs: [] },
        { id: 'c4', issue: 'x follow-up 2', subs: [] },
      ] },
      { id: 'c3', issue: 'unrelated later post', subs: [] },
    ]);

    const md = readFileSync(result.mdPath, 'utf8');
    const c1Idx = md.indexOf('### 1. c1');
    const c2Idx = md.indexOf('### 1.1. ↳ c2');
    const c4Idx = md.indexOf('### 1.2. ↳ c4');
    const c3Idx = md.indexOf('### 2. c3');
    assert.ok(c1Idx >= 0 && c2Idx >= 0 && c4Idx >= 0 && c3Idx >= 0, 'expected hierarchical numbering with reply markers, not a flat list');
    assert.ok(c1Idx < c2Idx && c2Idx < c4Idx && c4Idx < c3Idx, 'legacy comments must render oldest-first, nested, not in their old newest-batch-first order');
  });

  it('creates and synchronizes _overview.json and dashboard.html on summary finalization', async () => {
    writeCaseJson('08000022', {
      status: 'Open',
      comments: [{ id: 'c1', timestamp: 't1', author: 'A', body: 'first' }],
    });
    const { finalize } = await importOrchestrator();
    const result = finalize('08000022', {
      comments: [{ id: 'c1', timestamp: 't1', author: 'A', issue: 'x', nextAction: 'wait' }],
      flow: 'Customer reported x.',
      executive: {
        resolution: 'Fixed in patch v2',
      },
    });
    assert.equal(result.status, 'summarized');

    const casesDir = join(process.env.QUALCOMM_ROOT, 'data', 'cases');
    const overviewFile = join(casesDir, '_overview.json');
    const dashboardFile = join(casesDir, 'dashboard.html');
    assert.equal(existsSync(overviewFile), true);
    assert.equal(existsSync(dashboardFile), true);

    const overview = JSON.parse(readFileSync(overviewFile, 'utf8'));
    const rec = overview.cases.find((c) => c.caseNumber === '08000022');
    assert.ok(rec);
    assert.equal(rec.hasSummary, true);
    assert.match(rec.aiSummary, /Fixed in patch v2/);
  });

  it('delegates overview cache update to dependency-injected syncCaseOverview option', async () => {
    writeCaseJson('08000023', {
      status: 'Open',
      comments: [{ id: 'c1', timestamp: 't1', author: 'A', body: 'first' }],
    });
    let syncCalledWith = null;
    const { finalize } = await importOrchestrator();
    const result = finalize(
      '08000023',
      {
        comments: [{ id: 'c1', timestamp: 't1', author: 'A', issue: 'x', nextAction: 'wait' }],
        flow: 'Customer reported x.',
      },
      {
        syncCaseOverview: (code, opts) => {
          syncCalledWith = { code, opts };
          return { hadEntry: true, overviewData: {}, rendered: true };
        },
      }
    );
    assert.equal(result.status, 'summarized');
    assert.ok(syncCalledWith);
    assert.equal(syncCalledWith.code, '08000023');
    assert.equal(syncCalledWith.opts.action, 'upsert');
  });

  it('warns to stderr and continues when syncCaseOverview throws', async (t) => {
    writeCaseJson('08000024', {
      status: 'Open',
      comments: [{ id: 'c1', timestamp: 't1', author: 'A', body: 'first' }],
    });
    const writeSpy = t.mock.method(process.stderr, 'write');
    const { finalize } = await importOrchestrator();
    const result = finalize(
      '08000024',
      {
        comments: [{ id: 'c1', timestamp: 't1', author: 'A', issue: 'x', nextAction: 'wait' }],
        flow: 'Customer reported x.',
      },
      {
        syncCaseOverview: () => {
          throw new Error('boom: simulated sync failure');
        },
      }
    );
    assert.equal(result.status, 'summarized');
    const warnings = writeSpy.mock.calls.map((c) => c.arguments[0]).join('');
    assert.match(warnings, /Warning: overview auto-sync failed \(boom: simulated sync failure\)/);
  });
});

describe('summarize() single-step interface', () => {
  it('single-step summarize with payload creates summary and cleans up .summary_temp.json', async (t) => {
    mockDeps(t, { status: 'created' });
    writeCaseJson('08000040', {
      status: 'Open',
      comments: [{ id: 'c1', timestamp: 't1', author: 'A', body: 'first' }],
    });

    const { summarize } = await importOrchestrator();
    const payload = {
      comments: [{ id: 'c1', timestamp: 't1', author: 'A', issue: 'x', nextAction: 'wait' }],
      flow: 'Customer reported x.',
    };

    const result = await summarize('08000040', payload);
    assert.equal(result.status, 'summarized');
    assert.ok(existsSync(result.summaryPath));
    assert.ok(existsSync(result.mdPath));

    const tempFile = join(caseDir('08000040'), '.summary_temp.json');
    assert.equal(existsSync(tempFile), false, '.summary_temp.json must be cleaned up after summarization');
  });

  it('single-step summarize on up-to-date case returns no-delta and leaves no temp file', async (t) => {
    mockDeps(t, { status: 'no-update' });
    writeCaseJson('08000041', {
      status: 'Closed',
      comments: [{ id: 'c1', timestamp: 't1', author: 'A', body: 'first' }],
    });
    writeSummaryJson('08000041', {
      caseNumber: '08000041',
      status: 'Closed',
      summarizedCommentIds: ['c1'],
      comments: [{ id: 'c1', issue: 'x' }],
      flow: 'Done.',
      lastSummarizedAt: '2026-08-20T00:00:00.000Z',
    });

    const { summarize } = await importOrchestrator();
    const result = await summarize('08000041', { comments: [], flow: 'Done.' });
    assert.equal(result.status, 'no-delta');

    const tempFile = join(caseDir('08000041'), '.summary_temp.json');
    assert.equal(existsSync(tempFile), false);
  });

  it('single-step summarize cleans up pre-existing legacy .summary_temp.json if present', async (t) => {
    mockDeps(t, { status: 'created' });
    writeCaseJson('08000043', {
      status: 'Open',
      comments: [{ id: 'c1', timestamp: 't1', author: 'A', body: 'first' }],
    });
    const tempFile = join(caseDir('08000043'), '.summary_temp.json');
    writeFileSync(tempFile, JSON.stringify({ stale: true }));
    assert.ok(existsSync(tempFile), 'pre-existing temp file created');

    const { summarize } = await importOrchestrator();
    const payload = {
      comments: [{ id: 'c1', timestamp: 't1', author: 'A', issue: 'x', nextAction: 'wait' }],
      flow: 'Customer reported x.',
    };

    const result = await summarize('08000043', payload);
    assert.equal(result.status, 'summarized');
    assert.equal(existsSync(tempFile), false, 'pre-existing temp file must be cleaned up');
  });

  it('single-step summarize without payload returns needs-summary preparation verdict', async (t) => {
    mockDeps(t, { status: 'created' });
    writeCaseJson('08000042', {
      status: 'Open',
      comments: [{ id: 'c1', timestamp: 't1', author: 'A', body: 'first' }],
    });

    const { summarize } = await importOrchestrator();
    const result = await summarize('08000042', null);
    assert.equal(result.status, 'needs-summary');
    assert.equal(result.deltaComments.length, 1);
  });
});

describe('readPayloadFromArgs()', () => {
  it('parses valid --payload json string', async () => {
    const { readPayloadFromArgs } = await importOrchestrator();
    const payload = await readPayloadFromArgs(['--payload', '{"flow":"ok"}']);
    assert.deepEqual(payload, { flow: 'ok' });
  });

  it('throws descriptive error when --payload is missing value', async () => {
    const { readPayloadFromArgs } = await importOrchestrator();
    await assert.rejects(
      async () => readPayloadFromArgs(['--payload']),
      /--payload requires a JSON string argument/,
    );
  });

  it('throws descriptive error when --input is missing file path', async () => {
    const { readPayloadFromArgs } = await importOrchestrator();
    await assert.rejects(
      async () => readPayloadFromArgs(['--input']),
      /payload file option requires a file path argument/,
    );
  });
});

