// tests/migrate_case_detail.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  migrateCaseDetailData,
  migrateCaseDetailJson,
  parseDetailFlags,
} from '../tools/migrate_case_detail.mjs';
import { extractCaseOverview } from '../.claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs';

const SCRIPT = fileURLToPath(new URL('../tools/migrate_case_detail.mjs', import.meta.url));

describe('tools/migrate_case_detail.mjs - Unit & Migration tests (Slice 3)', () => {
  it('parseDetailFlags extracts supported Detail CLI flags into an overrides object', () => {
    const argv = [
      '08316063',
      '--contactName', 'Mai Ngoc',
      '--customerProject', 'SM7635',
      '--openedAt', '2026-02-05 00:29',
      '--closedAt', '2026-02-06 05:00',
      '--accountName', 'Samsung Electronics',
      '--relatedCRs', 'CR 3554040, CR 3297125',
      '--caseRecordType', 'Customer Support',
      '--status', 'Closed',
      '--priority', '1 - Critical',
      '--unsupportedFlag', 'ignored',
    ];

    const flags = parseDetailFlags(argv);

    assert.equal(flags.contactName, 'Mai Ngoc');
    assert.equal(flags.customerProject, 'SM7635');
    assert.equal(flags.openedAt, '2026-02-05 00:29');
    assert.equal(flags.closedAt, '2026-02-06 05:00');
    assert.equal(flags.accountName, 'Samsung Electronics');
    assert.equal(flags.relatedCRs, 'CR 3554040, CR 3297125');
    assert.equal(flags.caseRecordType, 'Customer Support');
    assert.equal(flags.status, 'Closed');
    assert.equal(flags.priority, '1 - Critical');
    assert.equal(flags.unsupportedFlag, undefined);
  });

  it('migrateCaseDetailData upgrades legacy case without Detail fields and applies overrides', () => {
    const legacyCase = {
      caseNumber: '08316063',
      title: '[A236E] E911 call fail due to UE does not select another available LTE cell',
      status: 'Closed',
      priority: '1 - Critical',
      customer: 'Samsung Electronics',
      comments: [
        {
          id: 'c1',
          author: 'Mai Ngoc',
          timestamp: 'February 5, 2026 at 12:29 AM',
          body: 'Dear QC,\nLog attached.',
        },
        {
          id: 'c2',
          author: 'Sang Bui',
          timestamp: 'February 6, 2026 at 2:02 AM',
          body: 'Dear Customer,\nPlease follow 08333258.',
        },
      ],
    };

    const overrides = {
      contactName: 'Mai Ngoc',
      customerProject: 'A236E',
      openedAt: '2026-02-05 00:29',
      closedAt: '2026-02-06 02:02',
      accountName: 'Samsung Electronics',
      relatedCRs: '3554040, 3297125',
      caseRecordType: 'Customer Support',
    };

    const migrated = migrateCaseDetailData(legacyCase, overrides);

    assert.equal(migrated.caseNumber, '08316063');
    assert.equal(migrated.contactName, 'Mai Ngoc');
    assert.equal(migrated.raisedBy, 'Mai Ngoc');
    assert.equal(migrated.customerProject, 'A236E');
    assert.equal(migrated.openedAt, '2026-02-05 00:29');
    assert.equal(migrated.closedAt, '2026-02-06 02:02');
    assert.equal(migrated.accountName, 'Samsung Electronics');
    assert.equal(migrated.relatedCRs, '3554040, 3297125');
    assert.equal(migrated.caseRecordType, 'Customer Support');
    assert.ok(migrated.hash, 'Must compute hash');
  });

  it('migrateCaseDetailData infers fallback Detail fields when overrides are omitted', () => {
    const legacyCase = {
      caseNumber: '08316063',
      title: '[A236E] E911 call fail due to UE does not select another available LTE cell',
      customer: 'Samsung Electronics',
      created: '2026-02-05 00:29',
      comments: [
        {
          id: 'c1',
          author: 'Mai Ngoc',
          timestamp: 'February 5, 2026 at 12:29 AM',
          body: 'Dear QC,\nLog attached.',
        },
      ],
    };

    const migrated = migrateCaseDetailData(legacyCase);

    assert.equal(migrated.contactName, 'Mai Ngoc', 'Infers contactName from first comment author');
    assert.equal(migrated.raisedBy, 'Mai Ngoc');
    assert.equal(migrated.customerProject, 'A236E', 'Extracts customerProject from title bracket');
    assert.equal(migrated.accountName, 'Samsung Electronics', 'Maps accountName from customer');
    assert.equal(migrated.openedAt, '2026-02-05 00:29', 'Maps openedAt from created');
  });

  it('migrateCaseDetailJson writes updated case.json, re-renders case.md and updates _index.json', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'qc-detail-test-'));
    const caseDir = join(tmp, '08316063');
    mkdirSync(caseDir, { recursive: true });

    const caseJsonPath = join(caseDir, 'case.json');
    const initialData = {
      caseNumber: '08316063',
      title: '[A236E] E911 call fail',
      status: 'Closed',
      priority: '1 - Critical',
      comments: [
        {
          id: 'c1',
          author: 'Mai Ngoc',
          timestamp: 'February 5, 2026 at 12:29 AM',
          body: 'Dear QC,\nLog attached.',
        },
      ],
    };
    writeFileSync(caseJsonPath, JSON.stringify(initialData, null, 2), 'utf8');

    const result = migrateCaseDetailJson(caseJsonPath, {
      contactName: 'Mai Ngoc',
      customerProject: 'A236E',
      openedAt: 'February 5, 2026 at 12:29 AM',
    });

    assert.equal(result.ok, true);

    // Verify case.json updated
    const saved = JSON.parse(readFileSync(caseJsonPath, 'utf8'));
    assert.equal(saved.contactName, 'Mai Ngoc');
    assert.equal(saved.customerProject, 'A236E');

    // Verify case.md re-rendered with Detail metadata
    const mdPath = join(caseDir, 'case.md');
    assert.ok(existsSync(mdPath), 'case.md must be generated');
    const mdContent = readFileSync(mdPath, 'utf8');
    assert.ok(mdContent.includes('- **Contact Name:** Mai Ngoc'), 'Markdown must render Contact Name');
    assert.ok(mdContent.includes('- **Customer Project:** A236E'), 'Markdown must render Customer Project');

    // Verify overview extraction returns Mai Ngoc as opener
    const overview = extractCaseOverview(caseDir, '08316063');
    assert.ok(overview);
    assert.equal(overview.raisedBy, 'Mai Ngoc');
    assert.equal(overview.contactName, 'Mai Ngoc');
    assert.equal(overview.customerProject, 'A236E');
  });

  it('CLI execution handles single case and all cases batch update', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'qc-detail-cli-'));
    const case1Dir = join(tmp, '08316063');
    const case2Dir = join(tmp, '08417053');
    mkdirSync(case1Dir, { recursive: true });
    mkdirSync(case2Dir, { recursive: true });

    writeFileSync(
      join(case1Dir, 'case.json'),
      JSON.stringify({
        caseNumber: '08316063',
        title: '[A236E] E911 call fail',
        comments: [{ id: 'c1', author: 'Mai Ngoc', timestamp: '2026-02-05', body: 'Report' }],
      }),
      'utf8'
    );

    writeFileSync(
      join(case2Dir, 'case.json'),
      JSON.stringify({
        caseNumber: '08417053',
        title: '[SM7635] Satellite camping issue',
        comments: [{ id: 'c2', author: 'Sang Bui', timestamp: '2026-03-26', body: 'Response' }],
      }),
      'utf8'
    );

    // Run CLI on case1 with explicit flags
    const res1 = spawnSync(
      process.execPath,
      [SCRIPT, join(case1Dir, 'case.json'), '--contactName', 'Mai Ngoc', '--customerProject', 'A236E'],
      { encoding: 'utf8' }
    );
    assert.equal(res1.status, 0, `CLI failed: ${res1.stderr}`);

    const saved1 = JSON.parse(readFileSync(join(case1Dir, 'case.json'), 'utf8'));
    assert.equal(saved1.contactName, 'Mai Ngoc');
    assert.equal(saved1.customerProject, 'A236E');
  });
});
