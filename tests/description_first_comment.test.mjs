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

const SCRAPE_SCRIPT = fileURLToPath(new URL('../.claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs', import.meta.url));
const RENDER_SCRIPT = fileURLToPath(new URL('../.claude/skills/qualcomm-case-agent/scripts/render_case.mjs', import.meta.url));

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
      contactName: 'Samsung Mobile',
      openedAt: '2026-08-20T09:30:00.000Z',
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
      contactName: 'Samsung Mobile',
      openedAt: '2026-08-10T08:00:00.000Z',
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

    // Newest-first presentation order: the chatter reply (11:00) precedes the
    // synthesized description comment (08:00, the case's own opening time).
    const firstComment = saved.comments[0];
    assert.equal(firstComment.author, 'QCOM Engineer');

    const secondComment = saved.comments[1];
    assert.equal(secondComment.author, 'Samsung Mobile');
    assert.equal(secondComment.timestamp, '2026-08-10T08:00:00.000Z');
    assert.equal(secondComment.body, raw.description);
    assert.equal(secondComment.summary, 'UE encounters panic during SA handover from cell A to cell B.');
    assert.match(secondComment.id, /^c[a-f0-9]{12}$/);
    assert.deepEqual(secondComment.attachments, []);
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
      contactName: 'Samsung Mobile',
      openedAt: '2026-08-10T08:00:00.000Z',
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
      contactName: 'Google OEM',
      openedAt: '2026-08-15T08:00:00.000Z',
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
      contactName: 'Google OEM',
      openedAt: '2026-08-15T08:00:00.000Z',
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
  it('renders case description in Description section and suppresses synthesized description comment from timeline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qc-render-desc-'));
    const caseData = {
      caseNumber: '08123456',
      title: '5G Attach Issue on Band n78',
      status: 'In Progress',
      priority: 'High',
      accountName: 'Xiaomi Mobile',
      openedAt: '2026-08-12T07:00:00.000Z',
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

    // 1. Description section is rendered
    assert.match(md, /^## Description$/m);
    assert.match(md, /Initial problem statement: attach reject received from network\./);

    // 2. Timeline must suppress synthesized description comment and render genuine comments starting at #1
    assert.match(md, /## Comments \(Newest First\)/);
    assert.match(md, /### 1\. 2026-08-12T09:00:00\.000Z · Qualcomm Support \(Qualcomm\)/);
    assert.match(md, /We are analyzing the attach reject code\./);
  });
});


