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
} from '../tools/migrate_case.mjs';

const SCRIPT = fileURLToPath(new URL('../tools/migrate_case.mjs', import.meta.url));

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

  it('sanitizeComment preserves valid timestamps and existing custom summaries', () => {
    const rawComment = {
      id: 'c456',
      author: 'Customer User',
      role: 'Customer',
      timestamp: 'August 10, 2026 at 10:00 AM',
      body: 'Hello,\nHere is the log file.',
      summary: 'Custom summary preview.',
      attachments: [],
    };

    const sanitized = sanitizeComment(rawComment);

    assert.equal(sanitized.timestamp, 'August 10, 2026 at 10:00 AM');
    assert.equal(sanitized.summary, 'Custom summary preview.');
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
});

