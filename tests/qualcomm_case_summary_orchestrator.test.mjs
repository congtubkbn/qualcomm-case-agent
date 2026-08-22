// Tests for qualcomm-case-summary's orchestrator (prepare/finalize).
// deps.mjs (captureCase) is mocked via node:test's module mocker so no test makes a
// real subprocess/browser call. Summarization itself is not mocked here because it is
// not a script-side effect: prepare() hands the model-input package to the calling
// agent, and finalize() takes the agent's already-produced comments/flow as input.
//     node --experimental-test-module-mocks --test tests/qualcomm_case_summary_orchestrator.test.mjs

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

process.env.QUALCOMM_ROOT = mkdtempSync(join(tmpdir(), 'qc-summary-'));

const SCRIPTS = new URL('../.claude/skills/qualcomm-case-summary/scripts/', import.meta.url);
const DEPS_URL = new URL('deps.mjs', SCRIPTS);

function mockDeps(t, captureResult) {
  const captureCalls = [];
  t.mock.module(DEPS_URL, {
    exports: {
      captureCase: async (code) => {
        captureCalls.push(code);
        return typeof captureResult === 'function' ? captureResult(code) : captureResult;
      },
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

  for (const status of ['auth-required', 'not-found', 'blocked', 'busy', 'error']) {
    it(`capture-failure passthrough: ${status} surfaces as-is without attempting summarization`, async (t) => {
      mockDeps(t, { status, reason: `synthetic ${status}` });
      const { prepare } = await importOrchestrator();
      const result = await prepare('08000099');
      assert.equal(result.status, status);
      assert.equal(result.capture.reason, `synthetic ${status}`);
    });
  }
});

describe('finalize()', () => {
  it('merges the agent-produced summaries into summary.json and renders summary.md newest-first', async (t) => {
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

  it('update run: reads prior summary.json off disk, preserves its comments untouched, appends the new batch', async (t) => {
    mockDeps(t, { status: 'updated' });
    writeCaseJson('08000021', {
      status: 'Pending Qualcomm',
      comments: [
        { id: 'c1', timestamp: 't1', author: 'A', body: 'first' },
        { id: 'c2', timestamp: 't2', author: 'B', body: 'second' },
        { id: 'c3', timestamp: 't3', author: 'C', body: 'third' },
      ],
    });
    const priorC1 = { id: 'c1', timestamp: 't1', author: 'A', issue: 'x', status: 'FAIL' };
    const priorC2 = { id: 'c2', timestamp: 't2', author: 'B', nextAction: 'wait for logs' };
    writeSummaryJson('08000021', {
      caseNumber: '08000021',
      status: 'Open',
      summarizedCommentIds: ['c1', 'c2'],
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
    assert.deepEqual(written.comments[2], { id: 'c3', timestamp: 't3', author: 'C', nextAction: 'escalate' });
    assert.equal(written.flow, 'A reported x (FAIL); B said wait for logs; C escalated.');
    assert.equal(written.status, 'Pending Qualcomm');

    const md = readFileSync(result.mdPath, 'utf8');
    const c3Idx = md.indexOf('### C (t3)');
    const c2Idx = md.indexOf('### B (t2)');
    const c1Idx = md.indexOf('### A (t1)');
    assert.ok(c3Idx < c2Idx && c2Idx < c1Idx, 'newest comment (c3) must render above older ones');
  });
});
