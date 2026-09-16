// End-to-end integration tests for cases_overview:
// 1. Finalize capture auto-sync hook -> _overview.json & dashboard.html
// 2. Multi-case stats aggregation, sorting, and CLI tool interactions
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_FINALIZE = fileURLToPath(
  new URL('../.claude/skills/qcomm/scripts/finalize_case.mjs', import.meta.url)
);
const SCRIPT_OVERVIEW = fileURLToPath(
  new URL('../.claude/skills/qcomm/scripts/cases_overview.mjs', import.meta.url)
);

function runFinalize(root, rawData, caseCode, flags = []) {
  const scratchPath = join(root, 'scratch_case.json');
  writeFileSync(scratchPath, JSON.stringify(rawData, null, 2), 'utf8');

  const res = spawnSync(
    process.execPath,
    [SCRIPT_FINALIZE, caseCode, scratchPath, ...flags],
    {
      env: { ...process.env, QUALCOMM_ROOT: root },
      encoding: 'utf8',
    }
  );

  let verdict = null;
  try {
    verdict = JSON.parse(res.stdout.split('\n').filter(Boolean).pop() || '{}');
  } catch {
    verdict = null;
  }

  return { exit: res.status, verdict, stdout: res.stdout, stderr: res.stderr };
}

function runOverviewCli(casesDir, args = []) {
  const res = spawnSync(
    process.execPath,
    [SCRIPT_OVERVIEW, `--cases-dir=${casesDir}`, ...args],
    {
      env: { ...process.env, QUALCOMM_NO_BROWSER: '1', NODE_ENV: 'test' },
      encoding: 'utf8',
    }
  );
  return { exit: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe('cases_overview: End-to-End Pipeline & Auto-Sync Hooks', () => {
  it('triggers auto-sync hook on finalize capture, summary finalize, and serves CLI queries', () => {
    const root = mkdtempSync(join(tmpdir(), 'qc-e2e-pipeline-'));
    const casesDir = join(root, 'data', 'cases');

    try {
      // 1. Initial Case Capture (08603854) via finalize_case.mjs
      const rawCase1 = {
        title: '[SM7635] EPS Fallback Failure during Emergency Call',
        status: 'Open',
        priority: '2 - High',
        product: 'SM7635',
        url: 'https://support.qualcomm.com/s/case/500dK00000HZeVSQA1',
        description: 'EPS fallback fails intermittently when VoNR is disabled in network profile.',
        accountName: 'Samsung Electronics',
        openedAt: 'July 15, 2026 at 2:30 AM',
        comments: [
          {
            id: 'c1',
            author: 'Engineer A',
            timestamp: 'July 15, 2026 at 3:00 AM',
            body: 'Investigating modem logs for handover failure reason.',
          },
          {
            id: 'c2',
            author: 'Qualcomm Support',
            timestamp: 'July 16, 2026 at 10:00 AM',
            body: 'Please provide QXDM logs with DE.3.1.4 build mask enabled.',
          },
        ],
      };

      const finalizeRes1 = runFinalize(root, rawCase1, '08603854', [
        '--title', rawCase1.title,
        '--status', rawCase1.status,
        '--priority', rawCase1.priority,
      ]);

      assert.equal(finalizeRes1.exit, 0, `finalize_case exit was ${finalizeRes1.exit}: ${finalizeRes1.stderr}`);
      assert.ok(existsSync(join(casesDir, '08603854', 'case.json')));
      assert.ok(existsSync(join(casesDir, '_overview.json')), '_overview.json should be auto-created on capture');
      assert.ok(existsSync(join(casesDir, 'dashboard.html')), 'dashboard.html should be auto-created on capture');

      const dashboardHtml1 = readFileSync(join(casesDir, 'dashboard.html'), 'utf8');
      assert.ok(dashboardHtml1.includes('href="qc://case/08603854"'));
      assert.ok(dashboardHtml1.includes('title="Open in Qualcomm Profile (qc://)"'));

      // Verify overview contents after capture
      const overview1 = JSON.parse(readFileSync(join(casesDir, '_overview.json'), 'utf8'));
      assert.equal(overview1.stats.total, 1);
      assert.equal(overview1.stats.byStatus['Open'], 1);
      assert.equal(overview1.cases.length, 1);

      const record1 = overview1.cases[0];
      assert.equal(record1.caseNumber, '08603854');
      assert.equal(record1.title, '[SM7635] EPS Fallback Failure during Emergency Call');
      assert.equal(record1.status, 'Open');
      assert.equal(record1.product, 'SM7635');
      // Description is injected as initial comment + 2 comments = 3 comments
      assert.equal(record1.commentCount, 3);
      assert.equal(record1.latestComments.length, 3);
      assert.equal(record1.latestComments[0].author, 'Qualcomm Support');

      // 2. Second Case Capture (08701234)
      const rawCase2 = {
        title: '[SDX75] 5G SA Registration Reject 58',
        status: 'Closed-Resolved',
        priority: '3 - Medium',
        product: 'SDX75',
        url: 'https://support.qualcomm.com/s/case/500dK00000HZeXYZ',
        description: 'Network rejects registration with cause #58.',
        accountName: 'Samsung Electronics',
        openedAt: 'August 1, 2026 at 1:00 PM',
        comments: [
          {
            id: 'c1',
            author: 'Engineer B',
            timestamp: 'August 1, 2026 at 1:15 PM',
            body: 'Initial report submitted.',
          },
          {
            id: 'c2',
            author: 'Qualcomm Tech Support',
            timestamp: 'August 2, 2026 at 9:00 AM',
            body: 'Fix verified in firmware release 2.4.1.',
          },
        ],
      };

      const finalizeRes2 = runFinalize(root, rawCase2, '08701234', [
        '--title', rawCase2.title,
        '--status', rawCase2.status,
        '--priority', rawCase2.priority,
      ]);
      assert.equal(finalizeRes2.exit, 0);

      // Verify updated stats with 2 cases
      const overview2 = JSON.parse(readFileSync(join(casesDir, '_overview.json'), 'utf8'));
      assert.equal(overview2.stats.total, 2);
      assert.equal(overview2.stats.byStatus['Open'], 1);
      assert.equal(overview2.stats.byStatus['Closed-Resolved'], 1);

      // 3. Test CLI interactions against the generated cache
      // A. Default table output
      const cliTable = runOverviewCli(casesDir);
      assert.equal(cliTable.exit, 0);
      assert.ok(cliTable.stdout.includes('QUALCOMM CASES OVERVIEW (2 cases)'));
      assert.ok(cliTable.stdout.includes('[08603854]'));
      assert.ok(cliTable.stdout.includes('[08701234]'));

      // B. JSON output
      const cliJson = runOverviewCli(casesDir, ['--json']);
      assert.equal(cliJson.exit, 0);
      const parsedJson = JSON.parse(cliJson.stdout);
      assert.equal(parsedJson.stats.total, 2);
      assert.equal(parsedJson.cases.length, 2);

      // C. Filter by status
      const cliFilterOpen = runOverviewCli(casesDir, ['--filter=open', '--json']);
      assert.equal(cliFilterOpen.exit, 0);
      const openCasesJson = JSON.parse(cliFilterOpen.stdout);
      assert.equal(openCasesJson.cases.length, 1);
      assert.equal(openCasesJson.cases[0].caseNumber, '08603854');

      const cliFilterClosed = runOverviewCli(casesDir, ['--filter=closed', '--json']);
      assert.equal(cliFilterClosed.exit, 0);
      const closedCasesJson = JSON.parse(cliFilterClosed.stdout);
      assert.equal(closedCasesJson.cases.length, 1);
      assert.equal(closedCasesJson.cases[0].caseNumber, '08701234');

      // D. Full Rebuild test
      rmSync(join(casesDir, '_overview.json'));
      rmSync(join(casesDir, 'dashboard.html'));
      assert.equal(existsSync(join(casesDir, '_overview.json')), false);

      const cliRebuild = runOverviewCli(casesDir, ['--rebuild']);
      assert.equal(cliRebuild.exit, 0);
      assert.ok(existsSync(join(casesDir, '_overview.json')));
      assert.ok(existsSync(join(casesDir, 'dashboard.html')));

      const rebuiltOverview = JSON.parse(readFileSync(join(casesDir, '_overview.json'), 'utf8'));
      assert.equal(rebuiltOverview.stats.total, 2);
      assert.equal(rebuiltOverview.cases.length, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});
