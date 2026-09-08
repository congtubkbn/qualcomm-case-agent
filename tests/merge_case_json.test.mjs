// Tests for the case.json union merge driver (issue #210, spec #205).
//
// The driver wraps finalize_case.mjs's existing mergeComments (already covered
// in tests/finalize_case.test.mjs) rather than inventing merge semantics — these
// tests cover the wrapping: pure text-in/text-out, scalar-field tie-break,
// idempotency, and that a merge commutes regardless of which side is "ours".

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { commentId } from '../.claude/skills/qualcomm-case-agent/scripts/finalize_case.mjs';
import { mergeCaseJson } from '../tools/merge_case_json.mjs';
import { ensureMergeDriverRegistered } from '../scripts/ensure_merge_driver.mjs';

const c = (author, body, timestamp) => {
  const base = { author, body, timestamp, attachments: [], parentId: null, summary: body };
  return { ...base, id: commentId(base) };
};

const baseCase = (overrides = {}) => JSON.stringify({
  caseNumber: '08603854',
  title: 'RRC reject on n78',
  status: 'In Progress',
  priority: 'P2',
  severity: '',
  product: 'X75',
  accountName: '',
  contactName: '',
  customerProject: '',
  customerTracking: '',
  relatedCRs: '',
  caseRecordType: '',
  openedAt: '',
  closedAt: '',
  updated: '',
  description: 'RRC reject seen during initial attach.',
  url: 'https://support.qualcomm.com/case/08603854',
  displayedCommentCount: 1,
  comments: [c('Alice', 'RRC reject seen on n78.', '2026-07-01T00:00:00.000Z')],
  detailExtracted: true,
  capture: {},
  hash: 'irrelevant-recomputed-by-driver',
  extractedAt: '2026-07-01T00:00:00.000Z',
  ...overrides,
}, null, 2);

describe('mergeCaseJson', () => {
  it('unions comments from both sides, keeping every comment id present on either', () => {
    const shared = c('Alice', 'RRC reject seen on n78.', '2026-07-01T00:00:00.000Z');
    const ours = baseCase({
      extractedAt: '2026-07-02T00:00:00.000Z',
      comments: [shared, c('Bob', 'We see the same on our end.', '2026-07-02T00:00:00.000Z')],
    });
    const theirs = baseCase({
      extractedAt: '2026-07-03T00:00:00.000Z',
      comments: [shared, c('Carol', 'Root cause identified.', '2026-07-03T00:00:00.000Z')],
    });

    const merged = JSON.parse(mergeCaseJson(ours, theirs));
    const authors = merged.comments.map(x => x.author).sort();
    assert.deepEqual(authors, ['Bob', 'Carol', 'Alice'].sort());
    assert.equal(merged.comments.length, 3, 'no lost comment, no duplicate of the shared one');
  });

  it('is idempotent — merging identical input reproduces it byte-for-byte (hash aside)', () => {
    const text = baseCase();
    const once = mergeCaseJson(text, text);
    const twice = mergeCaseJson(once, once);
    assert.equal(once, twice);
    assert.equal(JSON.parse(once).comments.length, 1, 'a comment present on both sides is not duplicated');
  });

  it('merges in the union order the repository already guarantees (newest-first)', () => {
    const older = c('Alice', 'RRC reject seen on n78.', '2026-07-01T00:00:00.000Z');
    const newer = c('Bob', 'Update from Qualcomm.', '2026-07-05T00:00:00.000Z');
    const ours = baseCase({ extractedAt: '2026-07-01T00:00:00.000Z', comments: [older] });
    const theirs = baseCase({ extractedAt: '2026-07-05T00:00:00.000Z', comments: [older, newer] });

    const merged = JSON.parse(mergeCaseJson(ours, theirs));
    assert.deepEqual(merged.comments.map(x => x.author), ['Bob', 'Alice']);
  });

  it('takes scalar fields from the side with the later extractedAt', () => {
    const ours = baseCase({ status: 'Waiting on Customer', extractedAt: '2026-07-01T00:00:00.000Z' });
    const theirs = baseCase({ status: 'Closed', extractedAt: '2026-07-05T00:00:00.000Z' });
    assert.equal(JSON.parse(mergeCaseJson(ours, theirs)).status, 'Closed');
    assert.equal(JSON.parse(mergeCaseJson(theirs, ours)).status, 'Closed', 'independent of which side is "ours"');
  });

  it('fills a blank scalar field from the older side rather than dropping it', () => {
    const ours = baseCase({ accountName: '', extractedAt: '2026-07-05T00:00:00.000Z' });
    const theirs = baseCase({ accountName: 'Acme Mobile', extractedAt: '2026-07-01T00:00:00.000Z' });
    assert.equal(JSON.parse(mergeCaseJson(ours, theirs)).accountName, 'Acme Mobile');
  });

  it('commutes — merge(A, B) equals merge(B, A) even on a tied extractedAt', () => {
    const a = baseCase({ comments: [c('Alice', 'RRC reject seen on n78.', '2026-07-01T00:00:00.000Z')] });
    const b = baseCase({ comments: [c('Bob', 'Also seeing this.', '2026-07-01T00:00:01.000Z')] });
    assert.equal(mergeCaseJson(a, b), mergeCaseJson(b, a));
  });

  it('recomputes hash over the merged, presentation-ordered comment set', () => {
    const shared = c('Alice', 'RRC reject seen on n78.', '2026-07-01T00:00:00.000Z');
    const ours = baseCase({ comments: [shared], hash: 'stale-ours' });
    const theirs = baseCase({
      extractedAt: '2026-07-02T00:00:00.000Z',
      comments: [shared, c('Bob', 'New info.', '2026-07-02T00:00:00.000Z')],
      hash: 'stale-theirs',
    });
    const merged = JSON.parse(mergeCaseJson(ours, theirs));
    assert.notEqual(merged.hash, 'stale-ours');
    assert.notEqual(merged.hash, 'stale-theirs');
  });
});

// Everything above tests the pure function; this exercises the wiring — the
// part a unit test on mergeCaseJson can't catch (a wrong .gitattributes
// pattern, a missing `merge.ours.driver`). A real `git merge` between two
// branches that each added a different comment must succeed with no conflict
// and no lost comment.
describe('git merge wiring (case.json union + case.md merge=ours)', () => {
  it('two divergent captures merge with no conflict and no lost comment', () => {
    const repo = mkdtempSync(join(tmpdir(), 'merge-case-json-'));
    const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

    assert.equal(git('init', '-q', '-b', 'main').status, 0);
    assert.equal(git('config', 'user.email', 'test@example.com').status, 0);
    assert.equal(git('config', 'user.name', 'Test').status, 0);

    // Exercises the real postinstall wiring (scripts/ensure_merge_driver.mjs),
    // not a hand-rolled stand-in for it — this is what actually catches a
    // wrong .gitattributes pattern or a missing merge.ours.driver.
    const registered = ensureMergeDriverRegistered({ dataCasesDir: repo, silent: true });
    assert.equal(registered.ok, true);
    assert.equal(registered.registered, true);

    writeFileSync(join(repo, '.gitattributes'), 'case.json merge=case-json-union\ncase.md merge=ours\n', 'utf8');
    const caseDir = join(repo, '08603854');
    mkdirSync(caseDir);
    const shared = c('Alice', 'RRC reject seen on n78.', '2026-07-01T00:00:00.000Z');
    writeFileSync(join(caseDir, 'case.json'), baseCase({ comments: [shared] }), 'utf8');
    writeFileSync(join(caseDir, 'case.md'), '# base\n', 'utf8');
    assert.equal(git('add', '-A').status, 0);
    assert.equal(git('commit', '-q', '-m', 'base').status, 0);

    assert.equal(git('checkout', '-q', '-b', 'machine-a').status, 0);
    writeFileSync(
      join(caseDir, 'case.json'),
      baseCase({ extractedAt: '2026-07-02T00:00:00.000Z', comments: [shared, c('Bob', 'Machine A comment.', '2026-07-02T00:00:00.000Z')] }),
      'utf8',
    );
    writeFileSync(join(caseDir, 'case.md'), '# machine A\n', 'utf8');
    assert.equal(git('commit', '-q', '-am', 'machine A capture').status, 0);

    assert.equal(git('checkout', '-q', 'main').status, 0);
    assert.equal(git('checkout', '-q', '-b', 'machine-b').status, 0);
    writeFileSync(
      join(caseDir, 'case.json'),
      baseCase({ extractedAt: '2026-07-03T00:00:00.000Z', comments: [shared, c('Carol', 'Machine B comment.', '2026-07-03T00:00:00.000Z')] }),
      'utf8',
    );
    writeFileSync(join(caseDir, 'case.md'), '# machine B\n', 'utf8');
    assert.equal(git('commit', '-q', '-am', 'machine B capture').status, 0);

    const merge = git('merge', '-q', '--no-edit', 'machine-a');
    assert.equal(merge.status, 0, `expected a clean merge, got: ${merge.stderr}`);

    const status = git('status', '--porcelain');
    assert.ok(
      !/^UU/m.test(status.stdout),
      `no unresolved/unmerged paths left behind, got: ${status.stdout}`,
    );

    const merged = JSON.parse(readFileSync(join(caseDir, 'case.json'), 'utf8'));
    assert.deepEqual(merged.comments.map(x => x.author).sort(), ['Alice', 'Bob', 'Carol'].sort());

    // case.md is merge=ours (never textually merged, so it can never carry
    // conflict markers) and is then redrawn by the post-merge hook from the
    // just-merged case.json — not left holding either side's placeholder text.
    const md = readFileSync(join(caseDir, 'case.md'), 'utf8');
    assert.ok(!md.includes('<<<<<<<'), 'case.md never carries real conflict markers');
    assert.ok(!md.includes('machine A') && !md.includes('machine B'), 'case.md was redrawn, not left as either side\'s stale content');
    assert.ok(md.includes('Bob') && md.includes('Carol'), 'case.md reflects the merged comment set');
  });
});
