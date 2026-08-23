// tests/migrate_case.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  sanitizeComment,
  migrateCaseData,
  migrateCaseJson,
  classifyRole,
} from '../.claude/skills/qualcomm-case-agent/scripts/migrate_case.mjs';

const SCRIPT = fileURLToPath(new URL('../.claude/skills/qualcomm-case-agent/scripts/migrate_case.mjs', import.meta.url));

describe('tools/migrate_case.mjs - Unit tests (Slice 1)', () => {
  it('sanitizeComment filters tooltip garbage timestamps, removes analysisLog, and generates summary', () => {
    const rawComment = {
      id: 'c123',
      author: 'Kyungnam Ken Lee',
      role: 'Qualcomm',
      timestamp: 'Click for single-item view of this post.',
      body: 'Dear customer,\n\nThank you for opening the case.\nWe will check and update.\n\nThank you',
      analysisLog: [{ step: 1 }],
      attachments: [],
    };

    const sanitized = sanitizeComment(rawComment);

    assert.equal(sanitized.id, 'c123');
    assert.equal(sanitized.author, 'Kyungnam Ken Lee');
    assert.equal(sanitized.timestamp, '', 'Tooltip garbage timestamp must be cleared to empty string');
    assert.equal('analysisLog' in sanitized, false, 'analysisLog property must be removed');
    assert.equal(sanitized.summary, 'Thank you for opening the case. We will check and update.');
  });

  it('sanitizeComment preserves valid timestamps and repairs a stale/garbage cached summary', () => {
    // Issue #86: a summary is always recomputed from body, never preserved
    // as-is — that's what let garbage previews (e.g. "1. 2." from a numbered
    // description) survive a migrate run indefinitely, since they were
    // non-empty and different from the body and so looked "already fine".
    const rawComment = {
      id: 'c456',
      author: 'Customer User',
      role: 'Customer',
      timestamp: 'August 10, 2026 at 10:00 AM',
      body: 'Hello,\nHere is the log file.',
      summary: '1. 2.',
      attachments: [],
    };

    const sanitized = sanitizeComment(rawComment);

    assert.equal(sanitized.timestamp, 'August 10, 2026 at 10:00 AM');
    assert.equal(sanitized.summary, 'Here is the log file.');
    assert.equal('analysisLog' in sanitized, false);
  });

  it('migrateCaseData transforms comments, updates roles, computes hash, and is idempotent', () => {
    const fixture = {
      caseNumber: '08637663',
      title: 'CR 4555226 side effect',
      url: 'https://support.qualcomm.com/s/case/500dK00000ONSaTQAX',
      comments: [
        {
          id: 'c_new1',
          author: 'Aiden An',
          role: 'Customer',
          body: 'Dear customer\nPlease check latest TAU update.\nThanks\nAiden',
          timestamp: 'Expand Post',
          analysisLog: [],
        },
        {
          id: 'c_old1',
          author: 'Kyungnam Ken Lee',
          role: 'Customer',
          body: 'Dear customer,\nThank you for opening the case.',
          timestamp: 'August 7, 2026 at 9:52 PM',
          analysisLog: [],
        },
        {
          id: 'c_mid1',
          author: 'Seunghoon Lee',
          role: 'Customer',
          body: 'Dear Customer,\nI will check and update you\nThanks,\nHoon',
          timestamp: 'August 9, 2026 at 6:07 PM',
          analysisLog: [],
        },
      ],
    };

    const migrated = migrateCaseData(fixture);

    assert.equal(migrated.caseNumber, '08637663');
    assert.equal(migrated.title, 'CR 4555226 side effect');
    assert.equal(migrated.comments.length, 3);

    // Oldest first
    assert.equal(migrated.comments[0].author, 'Kyungnam Ken Lee');
    assert.equal(migrated.comments[0].role, 'Qualcomm');
    assert.equal(migrated.comments[0].timestamp, 'August 7, 2026 at 9:52 PM');
    assert.equal('analysisLog' in migrated.comments[0], false);
    assert.ok(migrated.comments[0].summary);

    // Middle
    assert.equal(migrated.comments[1].author, 'Seunghoon Lee');
    assert.equal(migrated.comments[1].role, 'Qualcomm');
    assert.equal(migrated.comments[1].timestamp, 'August 9, 2026 at 6:07 PM');

    // Newest
    assert.equal(migrated.comments[2].author, 'Aiden An');
    assert.equal(migrated.comments[2].role, 'Qualcomm');
    assert.equal(migrated.comments[2].timestamp, '');

    assert.ok(migrated.hash);

    // Idempotency test
    const reMigrated = migrateCaseData(migrated);
    assert.deepEqual(reMigrated, migrated, 'Subsequent migration on already migrated data must be idempotent');
  });
});

describe('tools/migrate_case.mjs - Integration tests (Slice 2)', () => {
  it('re-sorts comments chronologically, fixes roles, and updates case.json and case.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qc-mig-'));
    const caseDir = join(dir, '08637663');
    mkdirSync(caseDir, { recursive: true });

    const fixture = {
      caseNumber: '08637663',
      title: 'CR 4555226 side effect',
      comments: [
        {
          id: 'c_new1',
          author: 'Aiden An',
          role: 'Customer',
          body: 'Dear customer\nPlease check latest TAU update.\nThanks\nAiden',
          timestamp: '',
        },
        {
          id: 'c_new2',
          author: 'beomjun kim',
          role: 'Customer',
          body: 'Dear QCOM\nFocus on VoNR.\nThanks.',
          timestamp: '',
        },
        {
          id: 'c_old1',
          author: 'Kyungnam Ken Lee',
          role: 'Customer',
          body: 'Dear customer,\nThank you for opening the case.',
          timestamp: 'August 7, 2026 at 9:52 PM',
        },
        {
          id: 'c_mid1',
          author: 'Seunghoon Lee',
          role: 'Customer',
          body: 'Dear Customer,\nI will check and update you\nThanks,\nHoon',
          timestamp: 'August 9, 2026 at 6:07 PM',
        },
      ],
    };

    const jsonPath = join(caseDir, 'case.json');
    writeFileSync(jsonPath, JSON.stringify(fixture, null, 2), 'utf8');

    const r = spawnSync(process.execPath, [SCRIPT, jsonPath], { encoding: 'utf8' });
    assert.equal(r.status, 0);

    const updated = JSON.parse(readFileSync(jsonPath, 'utf8'));
    assert.equal(updated.comments.length, 4);

    // Comment 0 should be Kyungnam Ken Lee (Aug 7)
    assert.equal(updated.comments[0].author, 'Kyungnam Ken Lee');
    assert.equal(updated.comments[0].role, 'Qualcomm');

    // Comment 1 should be Seunghoon Lee (Aug 9)
    assert.equal(updated.comments[1].author, 'Seunghoon Lee');
    assert.equal(updated.comments[1].role, 'Qualcomm');

    // Latest comments should be at the end
    assert.equal(updated.comments[2].author, 'Aiden An');
    assert.equal(updated.comments[2].role, 'Qualcomm');
    assert.equal(updated.comments[3].author, 'beomjun kim');
    assert.equal(updated.comments[3].role, 'Customer');

    // case.md should be rendered
    assert.ok(existsSync(join(caseDir, 'case.md')));
    const md = readFileSync(join(caseDir, 'case.md'), 'utf8');
    assert.match(md, /### 1\. August 7, 2026 at 9:52 PM · Kyungnam Ken Lee/);
  });

  it('updates _index.json when migrating case and synchronizes hash and commentCount', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'qc-data-'));
    const caseDir = join(dataDir, '08637663');
    mkdirSync(caseDir, { recursive: true });

    const fixture = {
      caseNumber: '08637663',
      title: 'CR 4555226 side effect',
      comments: [
        {
          id: 'c1',
          author: 'Kyungnam Ken Lee',
          role: 'Customer',
          body: 'Hello',
          timestamp: 'August 7, 2026 at 9:52 PM',
          analysisLog: [],
        },
      ],
    };

    const jsonPath = join(caseDir, 'case.json');
    writeFileSync(jsonPath, JSON.stringify(fixture, null, 2), 'utf8');

    const indexPath = join(dataDir, '_index.json');
    writeFileSync(indexPath, JSON.stringify({
      '08637663': {
        syncedAt: '2026-01-01T00:00:00.000Z',
        commentCount: 99,
        hash: 'oldhash',
      },
    }, null, 2), 'utf8');

    const res = migrateCaseJson(jsonPath, { indexPath });
    assert.equal(res.ok, true);
    assert.equal(res.commentCount, 1);

    const updatedIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
    assert.equal(updatedIndex['08637663'].commentCount, 1);
    assert.equal(updatedIndex['08637663'].hash, res.hash);
    assert.notEqual(updatedIndex['08637663'].syncedAt, '2026-01-01T00:00:00.000Z');
  });

  it('skill wrapper script (.claude/skills/.../scripts/migrate_case.mjs) executes correctly', () => {
    const wrapperScript = fileURLToPath(new URL('../.claude/skills/qualcomm-case-agent/scripts/migrate_case.mjs', import.meta.url));
    const tmp = mkdtempSync(join(tmpdir(), 'qc-wrap-'));
    const casePath = join(tmp, 'case.json');
    writeFileSync(casePath, JSON.stringify({
      caseNumber: '08999999',
      title: 'Wrapper test',
      comments: [
        { id: 'c1', author: 'Aiden An', body: 'Test comment', timestamp: 'Expand Post' }
      ]
    }, null, 2), 'utf8');

    const res = spawnSync(process.execPath, [wrapperScript, casePath], { encoding: 'utf8' });
    assert.equal(res.status, 0);

    const migrated = JSON.parse(readFileSync(casePath, 'utf8'));
    assert.equal(migrated.comments[0].timestamp, '');
    assert.equal(migrated.comments[0].role, 'Qualcomm');
    assert.equal(migrated.comments[0].summary, 'Test comment');
  });

  it('migrates legacy case with description into Comment #1 in case.json and case.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qc-mig-desc-'));
    const caseDir = join(dir, '08777777');
    mkdirSync(caseDir, { recursive: true });

    const legacyCase = {
      caseNumber: '08777777',
      title: 'Legacy VoNR Drop Issue',
      customer: 'Alpha Mobile',
      created: 'August 1, 2026 at 10:00 AM',
      description: 'Call drops consistently on band n78 after handover.',
      comments: [
        {
          id: 'c1',
          author: 'Qualcomm Engineer',
          role: 'Qualcomm',
          timestamp: 'August 2, 2026 at 2:00 PM',
          body: 'Dear customer,\nPlease provide modem QXDM logs.',
        },
      ],
    };

    const jsonPath = join(caseDir, 'case.json');
    writeFileSync(jsonPath, JSON.stringify(legacyCase, null, 2), 'utf8');

    const res = migrateCaseJson(jsonPath);
    assert.equal(res.ok, true);
    assert.equal(res.commentCount, 2);

    const updated = JSON.parse(readFileSync(jsonPath, 'utf8'));
    assert.equal(updated.comments.length, 2);
    // Comment 0 should be the injected description comment
    assert.equal(updated.comments[0].author, 'Alpha Mobile');
    assert.equal(updated.comments[0].timestamp, 'August 1, 2026 at 10:00 AM');
    assert.equal(updated.comments[0].body, 'Call drops consistently on band n78 after handover.');
    assert.equal(updated.comments[0].summary, 'Call drops consistently on band n78 after handover.');
    assert.equal(updated.comments[0].role, 'Customer');
    assert.deepEqual(updated.comments[0].attachments, []);

    // Comment 1 should be the Qualcomm response
    assert.equal(updated.comments[1].author, 'Qualcomm Engineer');

    // case.md should be rendered with ## Description section and suppressed description comment
    const md = readFileSync(join(caseDir, 'case.md'), 'utf8');
    assert.match(md, /^## Description$/m);
    assert.match(md, /Call drops consistently on band n78 after handover\./);
    assert.match(md, /### 1\. August 2, 2026 at 2:00 PM · Qualcomm Engineer \(Qualcomm\)/);

    // Idempotency: re-migrating should not add duplicates
    const res2 = migrateCaseJson(jsonPath);
    assert.equal(res2.commentCount, 2);
    assert.equal(res2.hash, res.hash);
  });

  it('never falls back to the real repo data/cases/_index.json when the fixture tree has no local index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qc-mig-noindex-'));
    const caseDir = join(dir, '08600321');
    mkdirSync(caseDir, { recursive: true });
    const jsonPath = join(caseDir, 'case.json');
    writeFileSync(jsonPath, JSON.stringify({
      caseNumber: '08600321',
      title: 'Fixture with no sibling _index.json',
      comments: [{ id: 'c1', author: 'Tester', timestamp: '2026-01-01', body: 'x' }],
    }, null, 2), 'utf8');

    const realIndexPath = fileURLToPath(new URL('../data/cases/_index.json', import.meta.url));
    const realIndexBefore = existsSync(realIndexPath) ? readFileSync(realIndexPath, 'utf8') : null;

    const res = migrateCaseJson(jsonPath);

    assert.equal(res.ok, true);
    assert.equal(existsSync(join(dir, '_index.json')), false);
    const realIndexAfter = existsSync(realIndexPath) ? readFileSync(realIndexPath, 'utf8') : null;
    assert.equal(realIndexAfter, realIndexBefore);
  });

  it('migrates a cached case with relative timestamps, normalizes to extractedAt, re-stamps hash once, and reports rehashed outcome', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qc-mig-rel-'));
    const caseDir = join(dir, '08642051');
    mkdirSync(caseDir, { recursive: true });

    const extractedAt = '2026-08-23T14:58:07.164Z';
    const legacyCase = {
      caseNumber: '08642051',
      title: 'Samsung Ecall test',
      extractedAt,
      comments: [
        {
          id: 'c1',
          author: 'Duc Hoang',
          role: 'Customer',
          timestamp: '12 days ago',
          body: 'FAILlog attached. Verbatim content with special chars: 04:39:48.820000 | 1 | NR5G NAS',
        },
        {
          id: 'c2',
          author: 'Sushmita Rao',
          role: 'Qualcomm',
          timestamp: 'August 11, 2026 at 9:44 AM',
          body: 'Checking from NAS POV.',
        },
      ],
      hash: 'old-stale-hash',
    };

    const jsonPath = join(caseDir, 'case.json');
    writeFileSync(jsonPath, JSON.stringify(legacyCase, null, 2), 'utf8');

    const res = migrateCaseJson(jsonPath);

    assert.equal(res.ok, true);
    assert.equal(res.rehashed, true);
    assert.notEqual(res.hash, 'old-stale-hash');
    assert.equal(res.oldHash, 'old-stale-hash');

    const updated = JSON.parse(readFileSync(jsonPath, 'utf8'));

    // Comment 0 should be Sushmita Rao (August 11, 2026 at 9:44 AM is earlier than 14:58)
    assert.equal(updated.comments[0].author, 'Sushmita Rao');
    assert.equal(updated.comments[0].timestamp, 'August 11, 2026 at 9:44 AM');
    assert.equal(updated.comments[0].body, 'Checking from NAS POV.');

    // Comment 1 should be Duc Hoang (12 days before 2026-08-23T14:58:07.164Z = 2026-08-11T14:58:07.164Z)
    const expectedDucTs = new Date(Date.parse(extractedAt) - 12 * 86400 * 1000).toISOString();
    assert.equal(updated.comments[1].author, 'Duc Hoang');
    assert.equal(updated.comments[1].timestamp, expectedDucTs);
    assert.equal(updated.comments[1].rawTimestamp, '12 days ago');
    assert.equal(updated.comments[1].body, 'FAILlog attached. Verbatim content with special chars: 04:39:48.820000 | 1 | NR5G NAS', 'Verbatim body must be untouched');

    // Idempotency: re-running migrate must not change hash or rehash again
    const res2 = migrateCaseJson(jsonPath);
    assert.equal(res2.rehashed, false);
    assert.equal(res2.hash, res.hash);
  });
});

describe('migrate_case: Issue #97 layout propagation and un-repairable body reporting', () => {
  it('re-renders document in new layout with byte-identical verbatim comment bodies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qc-mig-97-'));
    const caseDir = join(dir, '08998877');
    mkdirSync(caseDir, { recursive: true });

    const complexBody = 'Steps:\n1. Power on UE.\n2. Collect modem log.\n\n04:39:48.820 | 1 | NR5G NAS SERVICE REQUEST | status: OK';
    const initialCase = {
      caseNumber: '08998877',
      title: 'Attach drop after HO',
      customer: 'Samsung Mobile',
      created: '2026-08-10T08:00:00.000Z',
      description: 'Problem description on n78.',
      comments: [
        {
          id: 'c1',
          author: 'Duc Hoang',
          role: 'Customer',
          timestamp: '2026-08-10T09:00:00.000Z',
          body: complexBody,
        },
        {
          id: 'c2',
          author: 'Qualcomm Support',
          role: 'Qualcomm',
          timestamp: '2026-08-10T10:00:00.000Z',
          body: 'Dear customer,\nLog received.',
        },
      ],
    };

    const jsonPath = join(caseDir, 'case.json');
    writeFileSync(jsonPath, JSON.stringify(initialCase, null, 2), 'utf8');

    const res = migrateCaseJson(jsonPath);
    assert.equal(res.ok, true);

    // 1. Stored comment bodies are byte-identical before and after
    const saved = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const targetComment = saved.comments.find(c => c.author === 'Duc Hoang' && c.timestamp === '2026-08-10T09:00:00.000Z');
    assert.equal(targetComment.body, complexBody);
    
    // 2. case.md is re-rendered with new layout (Description section, roles, no summary line)
    const md = readFileSync(join(caseDir, 'case.md'), 'utf8');
    assert.match(md, /## Description\r?\n\r?\nProblem description on n78\./);
    assert.match(md, /### 1\. 2026-08-10T09:00:00\.000Z · Duc Hoang \(Customer\)/);
    assert.match(md, /### 2\. 2026-08-10T10:00:00\.000Z · Qualcomm Support \(Qualcomm\)/);
    assert.doesNotMatch(md, /> \*\*Summary:\*\*/);
  });

  it('detects and reports flattened comment bodies with delete-and-re-Capture remedy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qc-mig-flat-'));
    const caseDir = join(dir, '08642051');
    mkdirSync(caseDir, { recursive: true });

    const flattenedBody = 'Dear QC RRC team, Could you help check why modem does not trigger UlInformationTransfer to send SERVICE REQUEST? The equipment does not receive SERVICE REQUEST with type emergency serv fallback, therefore it does not turn on LTE cell, resulting e911 call fail. # FAILlog_X716B_SEAU_5G.zip 04:39:48.820000 | 1 | NR5G NAS SERVICE REQUEST | service_type_val :4 // Since there is no ULInformationTransfer message, the equipment does not receive a SERVICE REQUEST. # PASSlog_X716B.zip 01:26:27.935052 | 1 | NR5G NAS SERVICE REQUEST | service_type_val :4';
    const caseWithFlat = {
      caseNumber: '08642051',
      title: 'Flattened comment case',
      customer: 'Samsung Mobile',
      created: '2026-08-10T08:00:00.000Z',
      description: 'Ecall test',
      comments: [
        {
          id: 'c_flat',
          author: 'Duc Hoang',
          role: 'Customer',
          timestamp: '2026-08-10T09:00:00.000Z',
          body: flattenedBody,
        },
      ],
    };

    const jsonPath = join(caseDir, 'case.json');
    writeFileSync(jsonPath, JSON.stringify(caseWithFlat, null, 2), 'utf8');

    const res = migrateCaseJson(jsonPath);
    assert.equal(res.ok, true);
    assert.equal(res.hasFlattenedBodies, true);
    assert.equal(res.flattenedBodies.length, 1);
    assert.equal(res.remedy, 'delete-and-re-Capture');
  });

  it('Issue #90: cleans polluted Case Status and relatedCRs during migration without portal round-trip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qc-mig-affordance-'));
    const caseDir = join(dir, '08642051');
    mkdirSync(caseDir, { recursive: true });

    const pollutedCase = {
      caseNumber: '08642051',
      title: 'Polluted status test',
      status: 'Closed-Customer Requested\nEdit Status',
      priority: '1 - Critical\nEdit Priority',
      relatedCRs: 'Help Related CRs',
      contactName: 'Duc Hoang Preview',
      comments: [
        {
          id: 'c1',
          author: 'Duc Hoang',
          role: 'Customer',
          timestamp: '2026-08-10T09:00:00.000Z',
          body: 'Hello',
        },
      ],
    };

    const jsonPath = join(caseDir, 'case.json');
    writeFileSync(jsonPath, JSON.stringify(pollutedCase, null, 2), 'utf8');

    const res = migrateCaseJson(jsonPath);
    assert.equal(res.ok, true);

    const saved = JSON.parse(readFileSync(jsonPath, 'utf8'));
    assert.equal(saved.status, 'Closed-Customer Requested');
    assert.equal(saved.priority, '1 - Critical');
    assert.equal(saved.relatedCRs, '');
    assert.equal(saved.contactName, 'Duc Hoang');

    const md = readFileSync(join(caseDir, 'case.md'), 'utf8');
    assert.match(md, /\| Status \| Closed-Customer Requested \|/);
    assert.match(md, /\| Priority \| 1 - Critical \|/);
    assert.doesNotMatch(md, /Edit Status/);
    assert.doesNotMatch(md, /Help Related CRs/);
  });
});
