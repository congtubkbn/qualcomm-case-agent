// Unit and integration tests for cases_overview data scanning and aggregation engine.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildOverviewData,
  createCommentSnippet,
  extractAiSummary,
  extractCaseOverview,
  extractProductFromTitle,
  updateCaseOverview,
} from '../.claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs';

const SCRIPT = fileURLToPath(
  new URL('../.claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs', import.meta.url)
);

function createTempCasesDir() {
  const baseDir = mkdtempSync(join(tmpdir(), 'qc-overview-test-'));
  return baseDir;
}

describe('cases_overview: helpers', () => {
  it('createCommentSnippet normalizes whitespace and truncates accurately', () => {
    assert.equal(createCommentSnippet(null), '');
    assert.equal(createCommentSnippet({ body: '  Hello   World  \n\n  Test  ' }), 'Hello World Test');
    const longBody = 'A'.repeat(200);
    const snippet = createCommentSnippet({ body: longBody }, 50);
    assert.equal(snippet.length, 50);
    assert.ok(snippet.endsWith('...'));
  });

  it('extractProductFromTitle ignores build prefixes and finds chip/product models', () => {
    assert.equal(extractProductFromTitle('[DE.3.1.4][SM7635] issue'), 'SM7635');
    assert.equal(extractProductFromTitle('[LA.2.0][SDX75] handover issue'), 'SDX75');
    assert.equal(extractProductFromTitle('[IPQ9574] wifi crash'), 'IPQ9574');
    assert.equal(extractProductFromTitle('No product brackets here'), '');
    assert.equal(extractProductFromTitle(null), '');
  });

  it('extractAiSummary handles string, object, and missing executive summaries', () => {
    assert.equal(extractAiSummary(null), null);
    assert.equal(extractAiSummary({}), null);
    assert.equal(extractAiSummary({ summary: 'Simple summary' }), 'Simple summary');
    assert.equal(
      extractAiSummary({
        executive: {
          resolution: 'Fix applied',
          rootCause: 'Null pointer',
          blockerOrNextMilestone: 'None — fix delivered and case closed',
        },
      }),
      'Resolution: Fix applied | Root cause: Null pointer'
    );
    assert.equal(
      extractAiSummary({
        executive: {
          resolution: 'Fix pending',
          blockerOrNextMilestone: 'Awaiting customer log',
        },
      }),
      'Resolution: Fix pending | Next: Awaiting customer log'
    );
  });
});

describe('cases_overview: extractCaseOverview', () => {
  it('extracts metadata, summary, and top 3 newest comments from valid case directory', () => {
    const casesDir = createTempCasesDir();
    const caseDir = join(casesDir, '08603854');
    mkdirSync(caseDir, { recursive: true });

    const caseData = {
      caseNumber: '08603854',
      title: '[DE.3.1.4][SM7635] epsfb_if_emc_and_no_vonr does not work',
      status: 'Closed-Customer Requested',
      priority: '2 - High',
      product: 'SM7635',
      url: 'https://support.qualcomm.com/s/case/500dK00000Njp7aQAB/test-case',
      extractedAt: '2026-08-22T23:18:35.894Z',
      // case.json comments are newest-first (orderCommentsForPresentation).
      comments: [
        { id: 'c4', author: 'Luyen Kieu Ba', timestamp: 'July 22, 2026 at 5:42 AM', body: 'Fourth comment with details' },
        { id: 'c3', author: 'Sang Bui', timestamp: 'July 22, 2026 at 12:00 AM', body: 'Third comment' },
        { id: 'c2', author: 'Luyen Kieu Ba', timestamp: 'July 21, 2026 at 6:53 PM', body: 'Second comment' },
        { id: 'c1', author: 'Sang Bui', timestamp: 'July 20, 2026 at 12:14 AM', body: 'First comment' },
      ],
    };

    const summaryData = {
      caseNumber: '08603854',
      title: '[DE.3.1.4][SM7635] epsfb_if_emc_and_no_vonr does not work',
      executive: {
        resolution: 'CR3798678 fix delivered via test SBA',
        rootCause: 'nr5g_full_voice_support forced to EPSFB(0)',
      },
    };

    writeFileSync(join(caseDir, 'case.json'), JSON.stringify(caseData, null, 2), 'utf8');
    writeFileSync(join(caseDir, 'summary.json'), JSON.stringify(summaryData, null, 2), 'utf8');

    const result = extractCaseOverview(caseDir, '08603854');
    assert.ok(result, 'Result should not be null');
    assert.equal(result.caseNumber, '08603854');
    assert.equal(result.title, '[DE.3.1.4][SM7635] epsfb_if_emc_and_no_vonr does not work');
    assert.equal(result.status, 'Closed-Customer Requested');
    assert.equal(result.priority, '2 - High');
    assert.equal(result.product, 'SM7635');
    assert.equal(result.url, 'https://support.qualcomm.com/s/case/500dK00000Njp7aQAB/test-case');
    assert.equal(result.syncedAt, '2026-08-22T23:18:35.894Z');
    assert.equal(result.commentCount, 4);
    assert.equal(result.lastCommentAt, 'July 22, 2026 at 5:42 AM');
    assert.equal(result.lastCommentAuthor, 'Luyen Kieu Ba');
    assert.equal(result.hasSummary, true);
    assert.ok(result.aiSummary.includes('CR3798678 fix delivered'));
    assert.equal(result.latestComments.length, 3);
    // Should have top 3 newest comments (c4, c3, c2)
    assert.equal(result.latestComments[0].id, 'c4');
    assert.equal(result.latestComments[1].id, 'c3');
    assert.equal(result.latestComments[2].id, 'c2');
    assert.equal(result.latestComments[0].snippet, 'Fourth comment with details');

    rmSync(casesDir, { recursive: true, force: true });
  });

  it('handles case with no summary.json gracefully', () => {
    const casesDir = createTempCasesDir();
    const caseDir = join(casesDir, '08123456');
    mkdirSync(caseDir, { recursive: true });

    const caseData = {
      caseNumber: '08123456',
      title: 'Modem crash during handover',
      status: 'Open',
      priority: '1 - Critical',
      product: 'SDX75',
      comments: [
        { id: 'c1', author: 'John Doe', timestamp: 'Aug 01, 2026', body: 'Investigating modem crash logs.' },
      ],
    };

    writeFileSync(join(caseDir, 'case.json'), JSON.stringify(caseData, null, 2), 'utf8');

    const result = extractCaseOverview(caseDir, '08123456');
    assert.ok(result);
    assert.equal(result.caseNumber, '08123456');
    assert.equal(result.hasSummary, false);
    assert.equal(result.aiSummary, null);
    assert.equal(result.commentCount, 1);
    assert.equal(result.latestComments.length, 1);
    assert.equal(result.latestComments[0].author, 'John Doe');

    rmSync(casesDir, { recursive: true, force: true });
  });

  it('handles case with 0 comments and empty fields', () => {
    const casesDir = createTempCasesDir();
    const caseDir = join(casesDir, '08999999');
    mkdirSync(caseDir, { recursive: true });

    const caseData = {
      caseNumber: '08999999',
      title: 'Empty case with no comments',
      status: 'In Progress',
      comments: [],
    };

    writeFileSync(join(caseDir, 'case.json'), JSON.stringify(caseData, null, 2), 'utf8');

    const result = extractCaseOverview(caseDir, '08999999');
    assert.ok(result);
    assert.equal(result.caseNumber, '08999999');
    assert.equal(result.commentCount, 0);
    assert.equal(result.lastCommentAt, '');
    assert.equal(result.lastCommentAuthor, '');
    assert.deepEqual(result.latestComments, []);

    rmSync(casesDir, { recursive: true, force: true });
  });

  it('returns null for missing or invalid directory or corrupt case.json', () => {
    const casesDir = createTempCasesDir();
    const nonExistentDir = join(casesDir, 'non_existent');
    assert.equal(extractCaseOverview(nonExistentDir, 'non_existent'), null);

    const corruptDir = join(casesDir, 'corrupt_dir');
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, 'case.json'), '{invalid-json', 'utf8');
    assert.equal(extractCaseOverview(corruptDir, 'corrupt_dir'), null);

    rmSync(casesDir, { recursive: true, force: true });
  });

  it('extracts product from title brackets when product field is empty', () => {
    const casesDir = createTempCasesDir();
    const caseDir = join(casesDir, '08777777');
    mkdirSync(caseDir, { recursive: true });

    const caseData = {
      caseNumber: '08777777',
      title: '[DE.3.1.4][SM7635] epsfb_if_emc_and_no_vonr does not work',
      status: 'Open',
      product: '',
      comments: [],
    };

    writeFileSync(join(caseDir, 'case.json'), JSON.stringify(caseData, null, 2), 'utf8');

    const result = extractCaseOverview(caseDir, '08777777');
    assert.ok(result);
    assert.equal(result.product, 'SM7635');

    rmSync(casesDir, { recursive: true, force: true });
  });

  it('extracts raisedBy from raisedBy, creator, contactName, openedBy or falls back to the opener (oldest comment)', () => {
    const casesDir = createTempCasesDir();

    // 1. Prioritize contactName over creator and first comment author
    const case1Dir = join(casesDir, '08000001');
    mkdirSync(case1Dir, { recursive: true });
    writeFileSync(
      join(case1Dir, 'case.json'),
      JSON.stringify({
        caseNumber: '08000001',
        title: 'ContactName priority',
        contactName: 'Mai Ngoc',
        creator: 'Bob Jones',
        raisedBy: 'OEM-Alpha',
        customerProject: 'Titan-5G',
        openedAt: '2026-08-18 10:00',
        comments: [{ author: 'Charlie Brown' }],
      }),
      'utf8'
    );
    const case1 = extractCaseOverview(case1Dir, '08000001');
    assert.equal(case1?.raisedBy, 'Mai Ngoc');
    assert.equal(case1?.customerProject, 'Titan-5G');
    assert.equal(case1?.openedAt, '2026-08-18 10:00');

    // 2. Explicit raisedBy when contactName is missing
    const case2Dir = join(casesDir, '08000002');
    mkdirSync(case2Dir, { recursive: true });
    writeFileSync(
      join(case2Dir, 'case.json'),
      JSON.stringify({
        caseNumber: '08000002',
        title: 'Explicit raisedBy',
        raisedBy: 'Alice Smith',
        creator: 'Bob Jones',
        comments: [{ author: 'Charlie Brown' }],
      }),
      'utf8'
    );
    assert.equal(extractCaseOverview(case2Dir, '08000002')?.raisedBy, 'Alice Smith');

    // 3. Creator fallback
    const case3Dir = join(casesDir, '08000003');
    mkdirSync(case3Dir, { recursive: true });
    writeFileSync(
      join(case3Dir, 'case.json'),
      JSON.stringify({
        caseNumber: '08000003',
        title: 'Creator fallback',
        creator: 'David Clark',
        openedBy: 'Eve Adams',
        comments: [{ author: 'Charlie Brown' }],
      }),
      'utf8'
    );
    assert.equal(extractCaseOverview(case3Dir, '08000003')?.raisedBy, 'David Clark');

    // 4. OpenedBy fallback
    const case4Dir = join(casesDir, '08000004');
    mkdirSync(case4Dir, { recursive: true });
    writeFileSync(
      join(case4Dir, 'case.json'),
      JSON.stringify({
        caseNumber: '08000004',
        title: 'OpenedBy fallback',
        openedBy: 'Eve Adams',
        comments: [{ author: 'Charlie Brown' }],
      }),
      'utf8'
    );
    assert.equal(extractCaseOverview(case4Dir, '08000004')?.raisedBy, 'Eve Adams');

    // 5. Fallback to the opener (oldest comment, i.e. LAST in the newest-first array)
    const case5Dir = join(casesDir, '08000005');
    mkdirSync(case5Dir, { recursive: true });
    writeFileSync(
      join(case5Dir, 'case.json'),
      JSON.stringify({
        caseNumber: '08000005',
        title: 'Opener fallback',
        // newest-first: Latest Responder is newest, Charlie Brown opened the case (oldest, last).
        comments: [{ author: 'Latest Responder' }, { author: 'Charlie Brown' }],
      }),
      'utf8'
    );
    assert.equal(extractCaseOverview(case5Dir, '08000005')?.raisedBy, 'Charlie Brown');

    // 6. No creator and no comments -> empty string
    const case6Dir = join(casesDir, '08000006');
    mkdirSync(case6Dir, { recursive: true });
    writeFileSync(
      join(case6Dir, 'case.json'),
      JSON.stringify({
        caseNumber: '08000006',
        title: 'Empty fallback',
        comments: [],
      }),
      'utf8'
    );
    assert.equal(extractCaseOverview(case6Dir, '08000006')?.raisedBy, '');

    // 7. openedAt fallback to created
    const case7Dir = join(casesDir, '08000007');
    mkdirSync(case7Dir, { recursive: true });
    writeFileSync(
      join(case7Dir, 'case.json'),
      JSON.stringify({
        caseNumber: '08000007',
        title: 'openedAt created fallback',
        created: '2026-08-19T08:00:00.000Z',
        comments: [],
      }),
      'utf8'
    );
    assert.equal(extractCaseOverview(case7Dir, '08000007')?.openedAt, '2026-08-19T08:00:00.000Z');

    rmSync(casesDir, { recursive: true, force: true });
  });
});

describe('cases_overview: buildOverviewData', () => {
  it('scans all case directories, aggregates records, and calculates stats', () => {
    const casesDir = createTempCasesDir();

    // Create 2 case dirs and 1 non-case file/dir
    const case1Dir = join(casesDir, '08603854');
    mkdirSync(case1Dir, { recursive: true });
    writeFileSync(
      join(case1Dir, 'case.json'),
      JSON.stringify({
        caseNumber: '08603854',
        title: 'Case 1',
        status: 'Closed-Customer Requested',
        priority: '2 - High',
        extractedAt: '2026-08-20T10:00:00.000Z',
        comments: [{ id: 'c1', author: 'Dev', timestamp: '2026-08-20', body: 'Fixed' }],
      }),
      'utf8'
    );

    const case2Dir = join(casesDir, '08642051');
    mkdirSync(case2Dir, { recursive: true });
    writeFileSync(
      join(case2Dir, 'case.json'),
      JSON.stringify({
        caseNumber: '08642051',
        title: 'Case 2',
        status: 'Open',
        priority: '1 - Critical',
        extractedAt: '2026-08-21T10:00:00.000Z',
        comments: [],
      }),
      'utf8'
    );

    // Create a special underscore file that should be ignored
    writeFileSync(join(casesDir, '_index.json'), JSON.stringify({ test: true }), 'utf8');

    const overview = buildOverviewData(casesDir);
    assert.equal(overview.stats.total, 2);
    assert.equal(overview.cases.length, 2);
    assert.equal(overview.stats.byStatus['Closed-Customer Requested'], 1);
    assert.equal(overview.stats.byStatus['Open'], 1);
    assert.ok(overview.stats.lastUpdated);

    rmSync(casesDir, { recursive: true, force: true });
  });

  it('handles empty cases directory cleanly', () => {
    const casesDir = createTempCasesDir();
    const overview = buildOverviewData(casesDir);
    assert.equal(overview.stats.total, 0);
    assert.deepEqual(overview.cases, []);
    assert.deepEqual(overview.stats.byStatus, {});
    rmSync(casesDir, { recursive: true, force: true });
  });
});

describe('cases_overview: updateCaseOverview', () => {
  it('incrementally inserts new case and persists atomically to _overview.json', () => {
    const casesDir = createTempCasesDir();

    const case1Dir = join(casesDir, '08603854');
    mkdirSync(case1Dir, { recursive: true });
    writeFileSync(
      join(case1Dir, 'case.json'),
      JSON.stringify({
        caseNumber: '08603854',
        title: 'Case 1',
        status: 'Open',
        comments: [],
      }),
      'utf8'
    );

    const overviewFile = join(casesDir, '_overview.json');
    assert.ok(!existsSync(overviewFile));

    const updated = updateCaseOverview('08603854', casesDir);
    assert.ok(existsSync(overviewFile));
    assert.equal(updated.stats.total, 1);
    assert.equal(updated.cases[0].caseNumber, '08603854');

    // Add a second case
    const case2Dir = join(casesDir, '08642051');
    mkdirSync(case2Dir, { recursive: true });
    writeFileSync(
      join(case2Dir, 'case.json'),
      JSON.stringify({
        caseNumber: '08642051',
        title: 'Case 2',
        status: 'Closed',
        comments: [],
      }),
      'utf8'
    );

    const updated2 = updateCaseOverview('08642051', casesDir);
    assert.equal(updated2.stats.total, 2);
    assert.equal(updated2.stats.byStatus['Open'], 1);
    assert.equal(updated2.stats.byStatus['Closed'], 1);

    // Update case 1 status to In Progress
    writeFileSync(
      join(case1Dir, 'case.json'),
      JSON.stringify({
        caseNumber: '08603854',
        title: 'Case 1 Updated',
        status: 'In Progress',
        comments: [],
      }),
      'utf8'
    );

    const updated3 = updateCaseOverview('08603854', casesDir);
    assert.equal(updated3.stats.total, 2);
    assert.equal(updated3.stats.byStatus['Open'], undefined);
    assert.equal(updated3.stats.byStatus['In Progress'], 1);
    assert.equal(updated3.stats.byStatus['Closed'], 1);
    const case1Record = updated3.cases.find((c) => c.caseNumber === '08603854');
    assert.equal(case1Record.title, 'Case 1 Updated');

    // Removing non-existent case removes it from overview
    rmSync(case1Dir, { recursive: true, force: true });
    const updated4 = updateCaseOverview('08603854', casesDir);
    assert.equal(updated4.stats.total, 1);
    assert.equal(updated4.cases[0].caseNumber, '08642051');

    rmSync(casesDir, { recursive: true, force: true });
  });
});

describe('cases_overview: CLI contract', () => {
  it('supports --rebuild and --json flags via CLI', () => {
    const casesDir = createTempCasesDir();
    const case1Dir = join(casesDir, '08603854');
    mkdirSync(case1Dir, { recursive: true });
    writeFileSync(
      join(case1Dir, 'case.json'),
      JSON.stringify({
        caseNumber: '08603854',
        title: 'Case 1',
        status: 'Open',
        comments: [],
      }),
      'utf8'
    );

    const r = spawnSync(
      process.execPath,
      [SCRIPT, '--rebuild', '--json', `--cases-dir=${casesDir}`],
      { encoding: 'utf8' }
    );

    assert.equal(r.status, 0, `Process failed with error: ${r.stderr}`);
    const output = JSON.parse(r.stdout.trim());
    assert.equal(output.stats.total, 1);
    assert.equal(output.cases[0].caseNumber, '08603854');
    assert.ok(existsSync(join(casesDir, '_overview.json')));

    rmSync(casesDir, { recursive: true, force: true });
  });

  it('supports --filter=<status> flag via CLI', () => {
    const casesDir = createTempCasesDir();

    const case1Dir = join(casesDir, '08603854');
    mkdirSync(case1Dir, { recursive: true });
    writeFileSync(
      join(case1Dir, 'case.json'),
      JSON.stringify({ caseNumber: '08603854', title: 'Case 1', status: 'Open', comments: [] }),
      'utf8'
    );

    const case2Dir = join(casesDir, '08642051');
    mkdirSync(case2Dir, { recursive: true });
    writeFileSync(
      join(case2Dir, 'case.json'),
      JSON.stringify({ caseNumber: '08642051', title: 'Case 2', status: 'Closed', comments: [] }),
      'utf8'
    );

    const r = spawnSync(
      process.execPath,
      [SCRIPT, '--rebuild', '--json', '--filter=open', `--cases-dir=${casesDir}`],
      { encoding: 'utf8' }
    );

    assert.equal(r.status, 0, `Process failed with error: ${r.stderr}`);
    const output = JSON.parse(r.stdout.trim());
    assert.equal(output.cases.length, 1);
    assert.equal(output.cases[0].caseNumber, '08603854');

    rmSync(casesDir, { recursive: true, force: true });
  });

  it('supports --help flag via CLI', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('Usage: node .claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs'));
  });
});
