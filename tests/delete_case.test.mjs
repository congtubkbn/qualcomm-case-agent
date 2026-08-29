// Tests for delete_case.mjs — permanent, agent-confirmed case cache removal.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { deleteCase } from '../.claude/skills/qualcomm-case-agent/scripts/delete_case.mjs';

function createTempCasesDir() {
  return mkdtempSync(join(tmpdir(), 'qc-delete-test-'));
}

function seedCase(dataDir, code, extra = {}) {
  const caseDir = join(dataDir, code);
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, 'case.json'), JSON.stringify({
    caseNumber: code,
    title: `Case ${code}`,
    status: 'Open',
    comments: [],
    ...extra,
  }, null, 2), 'utf8');
  return caseDir;
}

describe('deleteCase', () => {
  it('deletes an existing case directory and reports status "deleted"', () => {
    const dataDir = createTempCasesDir();
    const caseDir = seedCase(dataDir, '08603854');

    const result = deleteCase('08603854', dataDir);

    assert.equal(result.status, 'deleted');
    assert.equal(existsSync(caseDir), false);
  });

  it('returns "not-found" without touching disk when the case does not exist', () => {
    const dataDir = createTempCasesDir();
    seedCase(dataDir, '08603854'); // unrelated sibling, must survive

    const result = deleteCase('08699999', dataDir);

    assert.equal(result.status, 'not-found');
    assert.equal(existsSync(join(dataDir, '08603854')), true);
  });

  it('returns "error" for a malformed (non-8-digit) case code without touching disk', () => {
    const dataDir = createTempCasesDir();
    seedCase(dataDir, '08603854');

    const result = deleteCase('not-a-code', dataDir);

    assert.equal(result.status, 'error');
    assert.equal(existsSync(join(dataDir, '08603854')), true);
  });

  it('leaves sibling case directories untouched', () => {
    const dataDir = createTempCasesDir();
    seedCase(dataDir, '08603854');
    const siblingDir = seedCase(dataDir, '08611111');

    deleteCase('08603854', dataDir);

    assert.equal(existsSync(siblingDir), true);
    assert.equal(existsSync(join(siblingDir, 'case.json')), true);
  });

  it('removes the deleted code\'s entry from _index.json while leaving other entries intact', () => {
    const dataDir = createTempCasesDir();
    seedCase(dataDir, '08603854');
    seedCase(dataDir, '08611111');
    writeFileSync(join(dataDir, '_index.json'), JSON.stringify({
      '08603854': { syncedAt: '2026-01-01T00:00:00.000Z', commentCount: 2, hash: 'abc' },
      '08611111': { syncedAt: '2026-01-02T00:00:00.000Z', commentCount: 1, hash: 'def' },
    }, null, 2), 'utf8');

    deleteCase('08603854', dataDir);

    const index = JSON.parse(readFileSync(join(dataDir, '_index.json'), 'utf8'));
    assert.equal('08603854' in index, false);
    assert.deepEqual(index['08611111'], { syncedAt: '2026-01-02T00:00:00.000Z', commentCount: 1, hash: 'def' });
  });

  it('regenerates _overview.json and dashboard.html without the deleted case', () => {
    const dataDir = createTempCasesDir();
    seedCase(dataDir, '08603854');
    seedCase(dataDir, '08611111');

    deleteCase('08603854', dataDir);

    const overview = JSON.parse(readFileSync(join(dataDir, '_overview.json'), 'utf8'));
    const caseNumbers = overview.cases.map(c => c.caseNumber);
    assert.equal(caseNumbers.includes('08603854'), false);
    assert.equal(caseNumbers.includes('08611111'), true);

    const dashboardHtml = readFileSync(join(dataDir, 'dashboard.html'), 'utf8');
    assert.equal(dashboardHtml.includes('08603854'), false);
    assert.equal(dashboardHtml.includes('08611111'), true);
  });

  it('cleans up a case still listed in _index.json/_overview.json/dashboard.html after its directory vanished out-of-band', () => {
    const dataDir = createTempCasesDir();
    seedCase(dataDir, '08603854');
    seedCase(dataDir, '08611111');
    writeFileSync(join(dataDir, '_index.json'), JSON.stringify({
      '08603854': { syncedAt: '2026-01-01T00:00:00.000Z', commentCount: 2, hash: 'abc' },
      '08611111': { syncedAt: '2026-01-02T00:00:00.000Z', commentCount: 1, hash: 'def' },
    }, null, 2), 'utf8');

    // Simulate the directory disappearing WITHOUT going through deleteCase
    // (manual rm, another tool, a crash mid-op) while stale entries remain.
    rmSync(join(dataDir, '08603854'), { recursive: true, force: true });
    // Re-seed it into _overview.json/dashboard.html the way a prior successful
    // sync would have left them (mirrors production: overview was built while
    // the dir still existed, then the dir vanished afterward).
    writeFileSync(join(dataDir, '_overview.json'), JSON.stringify({
      cases: [
        { caseNumber: '08603854', title: 'Case 08603854', status: 'Open' },
        { caseNumber: '08611111', title: 'Case 08611111', status: 'Open' },
      ],
      stats: { total: 2, byStatus: { Open: 2 }, lastUpdated: '2026-01-01T00:00:00.000Z' },
    }, null, 2), 'utf8');
    writeFileSync(join(dataDir, 'dashboard.html'), '<html>08603854 08611111</html>', 'utf8');

    const result = deleteCase('08603854', dataDir);

    assert.equal(result.status, 'deleted');

    const index = JSON.parse(readFileSync(join(dataDir, '_index.json'), 'utf8'));
    assert.equal('08603854' in index, false);

    const overview = JSON.parse(readFileSync(join(dataDir, '_overview.json'), 'utf8'));
    assert.equal(overview.cases.some(c => c.caseNumber === '08603854'), false);
    assert.equal(overview.cases.some(c => c.caseNumber === '08611111'), true);

    const dashboardHtml = readFileSync(join(dataDir, 'dashboard.html'), 'utf8');
    assert.equal(dashboardHtml.includes('08603854'), false);
  });

  it('still returns "not-found" without writing any file when the code has no trace anywhere', () => {
    const dataDir = createTempCasesDir();
    seedCase(dataDir, '08603854');

    const result = deleteCase('08699999', dataDir);

    assert.equal(result.status, 'not-found');
    assert.equal(existsSync(join(dataDir, '_index.json')), false);
    assert.equal(existsSync(join(dataDir, '_overview.json')), false);
  });

  // #143: a rendering bug in dashboard_renderer.mjs must not turn a genuinely
  // successful delete into a reported "error" — _overview.json write and the
  // deletion itself must both survive the render throwing.
  it('still writes _overview.json and reports "deleted" when the dashboard render throws', async (t) => {
    const dataDir = createTempCasesDir();
    const caseDir = seedCase(dataDir, '08603854');

    const DASHBOARD_URL = new URL(
      '../.claude/skills/qualcomm-case-overview/scripts/dashboard_renderer.mjs',
      import.meta.url
    );
    t.mock.module(DASHBOARD_URL, {
      exports: {
        renderDashboardHtml: () => { throw new Error('boom: simulated render bug'); },
      },
    });

    const { deleteCase: mockedDeleteCase } = await import(
      new URL(`../.claude/skills/qualcomm-case-agent/scripts/delete_case.mjs?t=${Date.now()}`, import.meta.url)
    );

    const result = mockedDeleteCase('08603854', dataDir);

    assert.equal(result.status, 'deleted');
    assert.equal(existsSync(caseDir), false);

    const overview = JSON.parse(readFileSync(join(dataDir, '_overview.json'), 'utf8'));
    assert.equal(overview.cases.some(c => c.caseNumber === '08603854'), false);
  });
});
