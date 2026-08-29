// Tests for delete_case.mjs — permanent, agent-confirmed case cache removal.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { deleteCase } from '../.claude/skills/qualcomm-case-agent/scripts/delete_case.mjs';
import { syncCaseOverview } from '../.claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs';

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
    syncCaseOverview('08603854', { casesDir: dataDir, action: 'upsert' });
    syncCaseOverview('08611111', { casesDir: dataDir, action: 'upsert' });

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
  it('still writes _overview.json and reports "deleted" when the dashboard render throws', (t) => {
    const dataDir = createTempCasesDir();
    const caseDir = seedCase(dataDir, '08603854');
    syncCaseOverview('08603854', { casesDir: dataDir, action: 'upsert' });
    const writeSpy = t.mock.method(process.stderr, 'write');

    const result = deleteCase('08603854', dataDir, {
      renderDashboard: () => { throw new Error('boom: simulated render bug'); },
    });

    assert.equal(result.status, 'deleted');
    assert.equal(existsSync(caseDir), false);

    const overview = JSON.parse(readFileSync(join(dataDir, '_overview.json'), 'utf8'));
    assert.equal(overview.cases.some(c => c.caseNumber === '08603854'), false);

    const warnings = writeSpy.mock.calls.map((c) => c.arguments[0]).join('');
    assert.match(warnings, /Warning: dashboard render failed \(boom: simulated render bug\)/);
  });

  it('delegates overview cache removal to dependency-injected syncCaseOverview option', () => {
    const dataDir = createTempCasesDir();
    seedCase(dataDir, '08603854');
    let syncCalledWith = null;

    const result = deleteCase('08603854', dataDir, {
      syncCaseOverview: (code, opts) => {
        syncCalledWith = { code, opts };
        return { hadEntry: true, overviewData: {}, rendered: true };
      },
    });

    assert.equal(result.status, 'deleted');
    assert.equal(syncCalledWith.code, '08603854');
    assert.equal(syncCalledWith.opts.action, 'remove');
    assert.equal(syncCalledWith.opts.casesDir, dataDir);
  });

  it('enforces action: "remove" and casesDir even if options specifies a conflicting action', () => {
    const dataDir = createTempCasesDir();
    seedCase(dataDir, '08603854');
    let syncCalledWith = null;

    deleteCase('08603854', dataDir, {
      action: 'upsert',
      casesDir: '/bogus/dir',
      syncCaseOverview: (code, opts) => {
        syncCalledWith = { code, opts };
        return { hadEntry: true, overviewData: {}, rendered: true };
      },
    });

    assert.equal(syncCalledWith.opts.action, 'remove');
    assert.equal(syncCalledWith.opts.casesDir, dataDir);
  });

  it('requesting deletion of a case absent from disk cache, index, and overview reports status: "not-found"', () => {
    const dataDir = createTempCasesDir();

    const result = deleteCase('08699999', dataDir);

    assert.deepEqual(result, {
      status: 'not-found',
      code: '08699999',
      reason: 'no local cache for case 08699999',
    });
    assert.equal(existsSync(join(dataDir, '_index.json')), false);
    assert.equal(existsSync(join(dataDir, '_overview.json')), false);
    assert.equal(existsSync(join(dataDir, 'dashboard.html')), false);
  });

  it('requesting deletion of a case present in overview cache (even if directory was already deleted out-of-band) purges the overview entry, updates dashboard, and returns status: "deleted"', () => {
    const dataDir = createTempCasesDir();
    // Case present ONLY in _overview.json, no directory, no _index.json
    writeFileSync(join(dataDir, '_overview.json'), JSON.stringify({
      cases: [
        { caseNumber: '08603854', title: 'Case 08603854', status: 'Open' },
        { caseNumber: '08611111', title: 'Case 08611111', status: 'Open' },
      ],
      stats: { total: 2, byStatus: { Open: 2 }, lastUpdated: '2026-01-01T00:00:00.000Z' },
    }, null, 2), 'utf8');

    const result = deleteCase('08603854', dataDir);

    assert.equal(result.status, 'deleted');
    assert.equal(result.code, '08603854');

    const overview = JSON.parse(readFileSync(join(dataDir, '_overview.json'), 'utf8'));
    assert.equal(overview.cases.some(c => c.caseNumber === '08603854'), false);
    assert.equal(overview.cases.some(c => c.caseNumber === '08611111'), true);

    const dashboardHtml = readFileSync(join(dataDir, 'dashboard.html'), 'utf8');
    assert.equal(dashboardHtml.includes('08603854'), false);
    assert.equal(dashboardHtml.includes('08611111'), true);
  });
});
