// Tests for the post-capture QA gate.
//     node --test tests/
//
// verifyCase() takes an explicit dir, so every case here is a throwaway folder
// built from a known-good fixture with exactly one thing broken.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const { verifyCase } = await import(new URL('../.claude/skills/qualcomm-case-agent/scripts/verify_case.mjs', import.meta.url));

function fixture(overrides = {}, { screenshot = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qc-verify-'));
  mkdirSync(dir, { recursive: true });
  const data = {
    caseNumber: '08000001',
    title: 'Test case',
    status: 'Open',
    url: 'https://support.qualcomm.com/s/case/x',
    hash: 'abc123',
    extractedAt: '2026-07-28T00:00:00.000Z',
    capture: { articles: 2, pendingExpand: 0, pendingMoreComments: 0, expandRounds: 3, screenshot: 'capture.png' },
    comments: [
      { id: 'c1', author: 'Alice', timestamp: '2 days ago', body: 'RRC reject on n78' },
      { id: 'c2', author: 'Bob', timestamp: '3 days ago', body: 'Attach accept seen' },
    ],
    ...overrides,
  };
  writeFileSync(join(dir, 'case.json'), JSON.stringify(data, null, 2), 'utf8');
  writeFileSync(join(dir, 'case.md'), '# Case Title\n\n- **Status:** Open\n', 'utf8');
  if (screenshot) writeFileSync(join(dir, 'capture.png'), 'PNG', 'utf8');
  return dir;
}

describe('verifyCase capture evidence and artifacts', () => {
  it('passes a capture that left no control unexpanded with case.json and case.md', () => {
    const r = verifyCase('08000001', fixture());
    assert.equal(r.ok, true, r.errors.join('; '));
  });

  it('fails when case.md is missing', () => {
    const dir = fixture();
    rmSync(join(dir, 'case.md'));
    const r = verifyCase('08000001', dir);
    assert.equal(r.ok, false);
    assert.match(r.errors.join('\n'), /case\.md was not rendered/);
  });

  // The whole point of the evidence block: a capture that persisted while a
  // reply thread was still collapsed looks complete in the JSON (case 08503838
  // dropped a reply with no error), so the gate has to read the counters.
  it('fails when a reply thread was still showing "more comments"', () => {
    const dir = fixture({ capture: { articles: 2, pendingExpand: 0, pendingMoreComments: 1, screenshot: 'capture.png' } });
    const r = verifyCase('08000001', dir);
    assert.equal(r.ok, false);
    assert.match(r.errors.join('\n'), /more comments/i);
  });

  it('fails when a post was still showing "Expand Post"', () => {
    const dir = fixture({ capture: { articles: 2, pendingExpand: 2, pendingMoreComments: 0, screenshot: 'capture.png' } });
    const r = verifyCase('08000001', dir);
    assert.equal(r.ok, false);
    assert.match(r.errors.join('\n'), /Expand Post/i);
  });

  it('warns — does not fail — on a cache written before evidence existed', () => {
    const dir = fixture({ capture: undefined });
    const r = verifyCase('08000001', dir);
    assert.equal(r.ok, true, r.errors.join('; '));
    assert.match(r.warnings.join('\n'), /capture evidence/i);
  });

  it('warns when the claimed screenshot is not on disk', () => {
    const dir = fixture({}, { screenshot: false });
    const r = verifyCase('08000001', dir);
    assert.equal(r.ok, true, r.errors.join('; '));
    assert.match(r.warnings.join('\n'), /capture\.png/);
  });

  // case 08460319: 5 persisted comments but portal badge said "4 Chatter Feed
  // Items" — comments[0] is scrape_case.mjs's synthesized description comment
  // (synthesizeDescriptionComment), which the portal badge never counts. The
  // gate must compare against genuineCommentCount(), not raw comments.length.
  it('does not warn when the extra comment is the synthesized description', () => {
    const dir = fixture({
      description: 'RRC reject on n78',
      displayedCommentCount: 2,
      comments: [
        { id: 'c1', author: 'Alice', timestamp: '2 days ago', body: 'RRC reject on n78' },
        { id: 'c2', author: 'Bob', timestamp: '3 days ago', body: 'Attach accept seen' },
        { id: 'c3', author: 'Carol', timestamp: '1 day ago', body: 'Confirmed fixed' },
      ],
    });
    const r = verifyCase('08000001', dir);
    assert.equal(r.ok, true, r.errors.join('; '));
    assert.doesNotMatch(r.warnings.join('\n'), /displayedCommentCount/);
  });
});
