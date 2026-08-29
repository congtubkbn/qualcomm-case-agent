// Tests for cases_overview.mjs's afterFinalize — the shared overview/dashboard sync
// seam both scrape_case.mjs and run_summary.mjs call after a case finalizes.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

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
  it('writes _overview.json and dashboard.html, and emits no warnings, on success', async (t) => {
    const dataDir = createTempCasesDir();
    seedCase(dataDir, '08603854');
    const writeSpy = t.mock.method(process.stderr, 'write');

    const { afterFinalize } = await import(
      new URL(`../.claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs?t=${Date.now()}`, import.meta.url)
    );

    afterFinalize('08603854', dataDir);

    assert.equal(existsSync(join(dataDir, '_overview.json')), true);
    assert.equal(existsSync(join(dataDir, 'dashboard.html')), true);
    assert.equal(writeSpy.mock.calls.length, 0);
  });

  it('warns "overview auto-sync failed" and does not throw when updateCaseOverview throws', async (t) => {
    const dataDir = createTempCasesDir();
    seedCase(dataDir, '08603854');
    const writeSpy = t.mock.method(process.stderr, 'write');

    const STORE_URL = new URL(
      '../.claude/skills/qualcomm-case-overview/scripts/overview_store.mjs',
      import.meta.url
    );
    const realStore = await import(STORE_URL);
    t.mock.module(STORE_URL, {
      exports: {
        ...realStore,
        updateCaseOverview: () => { throw new Error('boom: simulated store bug'); },
      },
    });

    const { afterFinalize } = await import(
      new URL(`../.claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs?t=${Date.now()}`, import.meta.url)
    );

    assert.doesNotThrow(() => afterFinalize('08603854', dataDir));

    const warnings = writeSpy.mock.calls.map((c) => c.arguments[0]).join('');
    assert.match(warnings, /Warning: overview auto-sync failed \(boom: simulated store bug\)/);
    assert.equal(existsSync(join(dataDir, 'dashboard.html')), false);
  });

  it('warns "dashboard render failed" and does not throw when renderDashboardHtml throws', async (t) => {
    const dataDir = createTempCasesDir();
    seedCase(dataDir, '08603854');
    const writeSpy = t.mock.method(process.stderr, 'write');

    const DASHBOARD_URL = new URL(
      '../.claude/skills/qualcomm-case-overview/scripts/dashboard_renderer.mjs',
      import.meta.url
    );
    t.mock.module(DASHBOARD_URL, {
      exports: {
        renderDashboardHtml: () => { throw new Error('boom: simulated render bug'); },
      },
    });

    const { afterFinalize } = await import(
      new URL(`../.claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs?t=${Date.now()}`, import.meta.url)
    );

    assert.doesNotThrow(() => afterFinalize('08603854', dataDir));

    const warnings = writeSpy.mock.calls.map((c) => c.arguments[0]).join('');
    assert.match(warnings, /Warning: dashboard render failed \(boom: simulated render bug\)/);

    const overview = JSON.parse(readFileSync(join(dataDir, '_overview.json'), 'utf8'));
    assert.equal(overview.cases.some((c) => c.caseNumber === '08603854'), true);
  });
});
