// Tests for cases_overview.mjs's afterFinalize — backwards-compatibility wrapper delegating to syncCaseOverview.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { afterFinalize } from '../.claude/skills/qcomm/scripts/cases_overview.mjs';

function createTempCasesDir() {
  return mkdtempSync(join(tmpdir(), 'qc-after-finalize-test-'));
}

function seedCase(dataDir, code) {
  const caseDir = join(dataDir, code);
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, 'case.json'), JSON.stringify({
    caseNumber: code,
    title: `Case ${code}`,
    status: 'Open',
    comments: [],
  }, null, 2), 'utf8');
  return caseDir;
}

describe('cases_overview: afterFinalize', () => {
  it('writes _overview.json and dashboard.html, and emits no warnings, on success', (t) => {
    const dataDir = createTempCasesDir();
    seedCase(dataDir, '08603854');
    const writeSpy = t.mock.method(process.stderr, 'write');

    afterFinalize('08603854', dataDir);

    assert.equal(existsSync(join(dataDir, '_overview.json')), true);
    assert.equal(existsSync(join(dataDir, 'dashboard.html')), true);
    assert.equal(writeSpy.mock.calls.length, 0);
  });

  it('warns "overview auto-sync failed" and does not throw when updateCaseOverview throws', (t) => {
    const dataDir = createTempCasesDir();
    seedCase(dataDir, '08603854');
    const writeSpy = t.mock.method(process.stderr, 'write');

    assert.doesNotThrow(() => afterFinalize('08603854', dataDir, {
      updateCaseOverview: () => { throw new Error('boom: simulated store bug'); },
    }));

    const warnings = writeSpy.mock.calls.map((c) => c.arguments[0]).join('');
    assert.match(warnings, /Warning: overview auto-sync failed \(boom: simulated store bug\)/);
    assert.equal(existsSync(join(dataDir, 'dashboard.html')), false);
  });

  it('warns "dashboard render failed" and does not throw when renderDashboardHtml throws', (t) => {
    const dataDir = createTempCasesDir();
    seedCase(dataDir, '08603854');
    const writeSpy = t.mock.method(process.stderr, 'write');

    assert.doesNotThrow(() => afterFinalize('08603854', dataDir, {
      renderDashboard: () => { throw new Error('boom: simulated render bug'); },
    }));

    const warnings = writeSpy.mock.calls.map((c) => c.arguments[0]).join('');
    assert.match(warnings, /Warning: dashboard render failed \(boom: simulated render bug\)/);

    const overview = JSON.parse(readFileSync(join(dataDir, '_overview.json'), 'utf8'));
    assert.equal(overview.cases.some((c) => c.caseNumber === '08603854'), true);
  });
});
