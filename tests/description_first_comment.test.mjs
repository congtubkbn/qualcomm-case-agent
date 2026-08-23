// tests/description_first_comment.test.mjs
// Comprehensive test suite for PRD #53 / Issues #54, #55, #56:
// Case Description as Initial Comment across Extraction, Ingestion, Merge, Rendering, and Migration.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  synthesizeDescriptionComment,
  hasDescriptionComment,
  extractSummary,
  assignIds,
  EXIT,
} from '../.claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs';

import {
  migrateCaseData,
  migrateCaseJson,
} from '../.claude/skills/qualcomm-case-agent/scripts/migrate_case.mjs';

const SCRAPE_SCRIPT = fileURLToPath(new URL('../.claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs', import.meta.url));
const RENDER_SCRIPT = fileURLToPath(new URL('../.claude/skills/qualcomm-case-agent/scripts/render_case.mjs', import.meta.url));
const MIGRATE_SCRIPT = fileURLToPath(new URL('../.claude/skills/qualcomm-case-agent/scripts/migrate_case.mjs', import.meta.url));

function createTempEnv(caseCode = '08123456') {
  const root = mkdtempSync(join(tmpdir(), 'qc-desc-test-'));
  const caseDir = join(root, 'data', 'cases', caseCode);
  mkdirSync(caseDir, { recursive: true });
  return { root, caseDir, caseCode };
}

function runScrape(root, rawObj, flags = [], caseCode = '08123456') {
  const rawPath = join(root, 'data', 'cases', caseCode, 'case.raw.json');
  writeFileSync(rawPath, JSON.stringify(rawObj, null, 2), 'utf8');
  const args = [SCRAPE_SCRIPT, caseCode, rawPath, ...flags];
  const r = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, QUALCOMM_ROOT: root },
  });
  let verdict = null;
  const lastLine = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
  if (lastLine && lastLine.startsWith('{')) {
    try {
      verdict = JSON.parse(lastLine);
    } catch {
      // not JSON
    }
  }
  return {
    exit: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    verdict,
    caseJsonPath: join(root, 'data', 'cases', caseCode, 'case.json'),
  };
}

describe('1. Extraction & Ingestion: synthesizeDescriptionComment & hasDescriptionComment', () => {
  it('synthesizes structured comment from valid description', () => {
    const raw = {
      customer: 'Samsung Mobile',
      created: '2026-08-20T09:30:00.000Z',
      description: 'Device crashes during 5G handover on n78 band.\n\nReproduction logs attached.\n\nThanks,\nKim',
    };
    const c = synthesizeDescriptionComment(raw);
    assert.ok(c);
    assert.equal(c.author, 'Samsung Mobile');
    assert.equal(c.timestamp, '2026-08-20T09:30:00.000Z');
    assert.equal(c.body, raw.description);
    // extractSummary is the single owner of preview generation, applied by
    // finalize() to every persisted comment — not by this synthesizer (see
    // "injects description as Comment #1" below for the full-pipeline check).
    assert.equal('summary' in c, false);
    assert.deepEqual(c.attachments, []);
  });

  it('falls back to "Reporter" and empty timestamp when fields are missing', () => {
    const raw = {
      description: 'VoNR registration failure with reject cause #111.',
    };
    const c = synthesizeDescriptionComment(raw);
    assert.ok(c);
    assert.equal(c.author, 'Reporter');
    assert.equal(c.timestamp, '');
    assert.equal(c.body, 'VoNR registration failure with reject cause #111.');
  });

  it('returns null for empty or whitespace-only description', () => {
    assert.equal(synthesizeDescriptionComment(null), null);
    assert.equal(synthesizeDescriptionComment({}), null);
    assert.equal(synthesizeDescriptionComment({ description: '' }), null);
    assert.equal(synthesizeDescriptionComment({ description: '   \t\n  ' }), null);
  });

  it('hasDescriptionComment accurately detects presence of description body', () => {
    const desc = 'Critical modem assertion failed at modem_init.c:450';
    const comments = [
      { body: 'Other comment' },
      { body: '  Critical modem assertion failed at modem_init.c:450  ' },
    ];
    assert.equal(hasDescriptionComment(comments, desc), true);
    assert.equal(hasDescriptionComment(comments, 'Different description'), false);
    assert.equal(hasDescriptionComment([], desc), false);
    assert.equal(hasDescriptionComment(null, desc), false);
    assert.equal(hasDescriptionComment(comments, ''), false);
  });
});

describe('2. Ingestion & Ingestion Pipeline: scrape_case.mjs full capture', () => {
  it('injects description as Comment #1 into persisted case.json while preserving root description', () => {
    const { root } = createTempEnv();
    const raw = {
      caseNumber: '08123456',
      title: 'Modem Crash on SA Handover',
      customer: 'Samsung Mobile',
      created: '2026-08-10T08:00:00.000Z',
      description: 'UE encounters panic during SA handover from cell A to cell B.',
      displayedCommentCount: 1, // portal's own count of genuine Chatter items only
      comments: [
        {
          author: 'QCOM Engineer',
          timestamp: '2026-08-10T11:00:00.000Z',
          body: 'Dear customer,\nPlease provide QXDM logs.',
        },
      ],
    };

    const res = runScrape(root, raw);
    assert.equal(res.exit, EXIT.OK);
    assert.equal(res.verdict.commentCount, 2); // 1 description + 1 chatter

    const saved = JSON.parse(readFileSync(res.caseJsonPath, 'utf8'));
    assert.equal(saved.description, raw.description, 'root description preserved');
    assert.equal(saved.comments.length, 2);

    const firstComment = saved.comments[0];
    assert.equal(firstComment.author, 'Samsung Mobile');
    assert.equal(firstComment.timestamp, '2026-08-10T08:00:00.000Z');
    assert.equal(firstComment.body, raw.description);
    assert.equal(firstComment.summary, 'UE encounters panic during SA handover from cell A to cell B.');
    assert.match(firstComment.id, /^c[a-f0-9]{12}$/);
    assert.deepEqual(firstComment.attachments, []);

    const secondComment = saved.comments[1];
    assert.equal(secondComment.author, 'QCOM Engineer');
  });

  it('does not create synthetic comment when description is empty', () => {
    const { root } = createTempEnv();
    const raw = {
      caseNumber: '08123456',
      title: 'Empty Desc Case',
      description: '   ',
      displayedCommentCount: 1,
      comments: [
        {
          author: 'QCOM Engineer',
          timestamp: '2026-08-10T11:00:00.000Z',
          body: 'Hello world',
        },
      ],
    };

    const res = runScrape(root, raw);
    assert.equal(res.exit, EXIT.OK);
    assert.equal(res.verdict.commentCount, 1);

    const saved = JSON.parse(readFileSync(res.caseJsonPath, 'utf8'));
    assert.equal(saved.comments.length, 1);
    assert.equal(saved.comments[0].author, 'QCOM Engineer');
  });

  // Regression for #88: the synthesized description comment was counted toward
  // the completeness gate, making it slack by exactly one — a capture missing
  // one genuine Chatter comment passed anyway because the description comment
  // padded the count back up to displayedCommentCount.
  it('rejects a capture one genuine comment short of the portal total, even with a synthesized description comment present', () => {
    const { root } = createTempEnv();
    const raw = {
      caseNumber: '08123456',
      title: 'Modem Crash on SA Handover',
      customer: 'Samsung Mobile',
      created: '2026-08-10T08:00:00.000Z',
      description: 'UE encounters panic during SA handover from cell A to cell B.',
      displayedCommentCount: 2, // portal shows 2 genuine Chatter items
      comments: [
        {
          author: 'QCOM Engineer',
          timestamp: '2026-08-10T11:00:00.000Z',
          body: 'Dear customer,\nPlease provide QXDM logs.',
        },
      ], // only 1 genuine comment actually captured
    };

    const res = runScrape(root, raw);
    assert.equal(res.exit, EXIT.INCOMPLETE);
    assert.equal(res.verdict.captured, 1, 'the synthesized description comment must not count');
    assert.equal(res.verdict.displayed, 2);
    assert.equal(existsSync(res.caseJsonPath), false, 'a short capture must not be persisted');
  });
});

describe('3. Dedup & Idempotency: scrape_case.mjs --merge', () => {
  it('does not duplicate description comment when updating case with --merge', () => {
    const { root } = createTempEnv();
    const initialRaw = {
      caseNumber: '08123456',
      title: 'VoNR Handover Drop',
      customer: 'Google OEM',
      created: '2026-08-15T08:00:00.000Z',
      description: 'Call drops consistently during VoNR handover.',
      displayedCommentCount: 1, // portal's own count of genuine Chatter items only
      comments: [
        {
          author: 'QCOM Support',
          timestamp: '2026-08-15T09:00:00.000Z',
          body: 'Under review.',
        },
      ],
    };

    // 1. Initial capture
    const r1 = runScrape(root, initialRaw);
    assert.equal(r1.exit, EXIT.OK);
    assert.equal(r1.verdict.commentCount, 2);

    // 2. Incremental update with new comment
    const updateRaw = {
      caseNumber: '08123456',
      title: 'VoNR Handover Drop',
      customer: 'Google OEM',
      created: '2026-08-15T08:00:00.000Z',
      description: 'Call drops consistently during VoNR handover.',
      displayedCommentCount: 2, // 2 genuine Chatter items (description excluded)
      comments: [
        {
          author: 'Google Engineer',
          timestamp: '2026-08-15T12:00:00.000Z',
          body: 'Here is the requested modem log.',
        },
        ...initialRaw.comments,
      ],
    };

    const r2 = runScrape(root, updateRaw, ['--merge']);
    assert.equal(r2.exit, EXIT.OK);
    assert.equal(r2.verdict.newComments, 1);

    const saved = JSON.parse(readFileSync(r1.caseJsonPath, 'utf8'));
    assert.equal(saved.comments.length, 3); // 1 desc + 1 initial chatter + 1 new chatter

    const descMatches = saved.comments.filter(c => c.body === initialRaw.description);
    assert.equal(descMatches.length, 1, 'Description comment must appear exactly once');

    // 3. Repeated merge with same data produces 0 new comments
    const r3 = runScrape(root, updateRaw, ['--merge']);
    assert.equal(r3.exit, EXIT.OK);
    assert.equal(r3.verdict.newComments, 0);

    const saved3 = JSON.parse(readFileSync(r1.caseJsonPath, 'utf8'));
    assert.equal(saved3.comments.length, 3);
  });
});

describe('4. Markdown Rendering: render_case.mjs', () => {
  it('renders case description as Comment #1 in chronological timeline without redundant standalone header', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qc-render-desc-'));
    const caseData = {
      caseNumber: '08123456',
      title: '5G Attach Issue on Band n78',
      status: 'In Progress',
      priority: 'High',
      customer: 'Xiaomi Mobile',
      created: '2026-08-12T07:00:00.000Z',
      updated: '2026-08-12T15:00:00.000Z',
      description: 'Initial problem statement: attach reject received from network.',
      comments: [
        {
          id: 'c_desc',
          author: 'Xiaomi Mobile',
          timestamp: '2026-08-12T07:00:00.000Z',
          summary: 'Initial problem statement: attach reject received from network.',
          body: 'Initial problem statement: attach reject received from network.',
          attachments: [],
        },
        {
          id: 'c_reply',
          author: 'Qualcomm Support',
          timestamp: '2026-08-12T09:00:00.000Z',
          summary: 'We are analyzing the attach reject code.',
          body: 'We are analyzing the attach reject code.',
          attachments: [{ name: 'log_guide.pdf', href: 'https://support.qualcomm.com/f/123' }],
        },
      ],
    };

    const jsonPath = join(dir, 'case.json');
    writeFileSync(jsonPath, JSON.stringify(caseData, null, 2), 'utf8');

    const r = spawnSync(process.execPath, [RENDER_SCRIPT, jsonPath], { encoding: 'utf8' });
    assert.equal(r.status, 0);

    const mdPath = join(dir, 'case.md');
    assert.ok(existsSync(mdPath), 'case.md must exist');
    const md = readFileSync(mdPath, 'utf8');

    // 1. Standalone ## Description must NOT be present
    assert.doesNotMatch(md, /^## Description$/m, 'Must omit redundant standalone description section');

    // 2. Timeline must render Comment #1 with customer and description body
    assert.match(md, /## Chronological Timeline of Comments/);
    assert.match(md, /### 1\. 2026-08-12T07:00:00\.000Z · Xiaomi Mobile/);
    assert.match(md, /Initial problem statement: attach reject received from network\./);

    // 3. Subsequent comment rendered
    assert.match(md, /### 2\. 2026-08-12T09:00:00\.000Z · Qualcomm Support/);
    assert.match(md, /We are analyzing the attach reject code\./);
  });
});

describe('5. Cached Case Migration: tools/migrate_case.mjs', () => {
  it('migrateCaseData injects description into legacy case and re-sorts chronologically', () => {
    const legacyCase = {
      caseNumber: '08555555',
      title: 'Legacy Case Title',
      customer: 'OnePlus OEM',
      created: '2026-08-01T06:00:00.000Z',
      description: 'Thermal throttling observed during 4K 60fps video recording.',
      comments: [
        {
          id: 'c1',
          author: 'QCOM Thermal Lead',
          timestamp: '2026-08-01T10:00:00.000Z',
          body: 'Please provide thermal sensor dump.',
        },
      ],
    };

    const migrated = migrateCaseData(legacyCase);
    assert.equal(migrated.comments.length, 2);

    // Comment 0 should be description comment
    assert.equal(migrated.comments[0].author, 'OnePlus OEM');
    assert.equal(migrated.comments[0].timestamp, '2026-08-01T06:00:00.000Z');
    assert.equal(migrated.comments[0].body, legacyCase.description);
    assert.equal(migrated.comments[0].role, 'Customer');
    assert.match(migrated.comments[0].id, /^c[a-f0-9]{12}$/);

    // Comment 1 should be response
    assert.equal(migrated.comments[1].author, 'QCOM Thermal Lead');
    assert.equal(migrated.comments[1].role, 'Qualcomm');

    // Retains root description
    assert.equal(migrated.description, legacyCase.description);

    // Idempotent
    const reMigrated = migrateCaseData(migrated);
    assert.deepEqual(reMigrated, migrated);
  });

  it('migrateCaseJson updates case.json and case.md on disk via CLI and API', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qc-mig-cli-'));
    const caseDir = join(dir, '08555555');
    mkdirSync(caseDir, { recursive: true });

    const legacyCase = {
      caseNumber: '08555555',
      title: 'Legacy Case Title',
      customer: 'OnePlus OEM',
      created: 'August 1, 2026 at 6:00 AM',
      description: 'Thermal throttling observed during 4K 60fps video recording.',
      comments: [
        {
          id: 'c1',
          author: 'QCOM Thermal Lead',
          timestamp: 'August 1, 2026 at 10:00 AM',
          body: 'Please provide thermal sensor dump.',
        },
      ],
    };

    const jsonPath = join(caseDir, 'case.json');
    writeFileSync(jsonPath, JSON.stringify(legacyCase, null, 2), 'utf8');

    // Run migration via CLI
    const r = spawnSync(process.execPath, [MIGRATE_SCRIPT, jsonPath], { encoding: 'utf8' });
    assert.equal(r.status, 0);

    const updated = JSON.parse(readFileSync(jsonPath, 'utf8'));
    assert.equal(updated.comments.length, 2);
    assert.equal(updated.comments[0].author, 'OnePlus OEM');
    assert.equal(updated.comments[0].body, legacyCase.description);

    const md = readFileSync(join(caseDir, 'case.md'), 'utf8');
    assert.doesNotMatch(md, /^## Description$/m);
    assert.match(md, /### 1\. August 1, 2026 at 6:00 AM · OnePlus OEM/);
    assert.match(md, /### 2\. August 1, 2026 at 10:00 AM · QCOM Thermal Lead/);
  });
});
