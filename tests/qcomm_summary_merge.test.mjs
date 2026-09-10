// Tests for qcomm's merge logic (pure, no mocking needed).
//     node --test tests/qcomm_summary_merge.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeSummary } from '../.claude/skills/qcomm/scripts/run_summary.mjs';

describe('mergeSummary', () => {
  it('first-ever merge: no prior summary -> summarizedCommentIds/comments start from the new batch', () => {
    const result = mergeSummary(null, {
      caseNumber: '08633581',
      status: 'Open',
      newComments: [{ id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait' }],
      flow: 'Customer reported x.',
      now: '2026-08-22T10:00:00.000Z',
    });
    assert.deepEqual(result, {
      caseNumber: '08633581',
      status: 'Open',
      summarizedCommentIds: ['c1'],
      comments: [{ id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait' }],
      flow: 'Customer reported x.',
      lastSummarizedAt: '2026-08-22T10:00:00.000Z',
    });
  });

  it('update merge: no parent info -> new comments prepended (newest-first), ids unioned', () => {
    const prior = {
      caseNumber: '08633581',
      status: 'Open',
      summarizedCommentIds: ['c1'],
      comments: [{ id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait' }],
      flow: 'Customer reported x.',
      lastSummarizedAt: '2026-08-22T10:00:00.000Z',
    };
    const result = mergeSummary(prior, {
      caseNumber: '08633581',
      status: 'Pending Qualcomm',
      newComments: [{ id: 'c2', issue: 'y', nextAction: 'escalate' }],
      flow: 'Customer reported x; Qualcomm asked for logs.',
      now: '2026-08-23T09:00:00.000Z',
    });
    assert.deepEqual(result.summarizedCommentIds, ['c1', 'c2']);
    assert.deepEqual(result.comments, [
      { id: 'c2', issue: 'y', nextAction: 'escalate' },
      { id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait' },
    ]);
    assert.equal(result.status, 'Pending Qualcomm');
    assert.equal(result.flow, 'Customer reported x; Qualcomm asked for logs.');
    assert.equal(result.lastSummarizedAt, '2026-08-23T09:00:00.000Z');
    // prior object itself must not be mutated
    assert.deepEqual(prior.summarizedCommentIds, ['c1']);
    assert.deepEqual(prior.comments, [{ id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait' }]);
  });

  it('reply to an already-summarized old post is inserted next to its parent, not prepended to the head', () => {
    const prior = {
      caseNumber: '08633581',
      status: 'Open',
      summarizedCommentIds: ['c1', 'c2'],
      comments: [
        { id: 'c2', issue: 'y', nextAction: 'escalate' },
        { id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait' },
      ],
      flow: 'Customer reported x; Qualcomm asked for logs.',
      lastSummarizedAt: '2026-08-23T09:00:00.000Z',
    };
    // c3 is a reply to c1 (the older, already-summarized post) — not to c2 (the newest one).
    const result = mergeSummary(prior, {
      caseNumber: '08633581',
      status: 'Pending Qualcomm',
      newComments: [{ id: 'c3', issue: 'x follow-up', nextAction: 'attach logs' }],
      parentIdOf: { c3: 'c1' },
      flow: 'Customer reported x; Qualcomm asked for logs; customer attached logs.',
      now: '2026-08-24T09:00:00.000Z',
    });
    assert.deepEqual(result.comments, [
      { id: 'c2', issue: 'y', nextAction: 'escalate' },
      { id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait' },
      { id: 'c3', issue: 'x follow-up', nextAction: 'attach logs' },
    ]);
    assert.deepEqual(result.summarizedCommentIds, ['c1', 'c2', 'c3']);
  });

  it('two same-batch replies to the same already-summarized parent land newest-first, directly after it', () => {
    const prior = {
      caseNumber: '08633581',
      status: 'Open',
      summarizedCommentIds: ['c1'],
      comments: [{ id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait' }],
      flow: 'Customer reported x.',
      lastSummarizedAt: '2026-08-22T10:00:00.000Z',
    };
    // c2 and c3 both reply to c1, delta arrives oldest-first (c2 before c3).
    const result = mergeSummary(prior, {
      caseNumber: '08633581',
      status: 'Pending Qualcomm',
      newComments: [
        { id: 'c2', issue: 'x older reply' },
        { id: 'c3', issue: 'x newer reply' },
      ],
      parentIdOf: { c2: 'c1', c3: 'c1' },
      flow: 'Customer reported x; two replies followed.',
      now: '2026-08-23T09:00:00.000Z',
    });
    assert.deepEqual(result.comments, [
      { id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait' },
      { id: 'c3', issue: 'x newer reply' },
      { id: 'c2', issue: 'x older reply' },
    ]);
  });

  it('a reply to a comment that is itself new in the same batch nests under that comment, not at the head', () => {
    const prior = {
      caseNumber: '08633581',
      status: 'Open',
      summarizedCommentIds: ['c1'],
      comments: [{ id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait' }],
      flow: 'Customer reported x.',
      lastSummarizedAt: '2026-08-22T10:00:00.000Z',
    };
    // c2 replies to c1 (old post); c3 replies to c2 (new, same batch) — a two-deep chain.
    const result = mergeSummary(prior, {
      caseNumber: '08633581',
      status: 'Pending Qualcomm',
      newComments: [
        { id: 'c2', issue: 'x reply' },
        { id: 'c3', issue: 'x reply follow-up' },
      ],
      parentIdOf: { c2: 'c1', c3: 'c2' },
      flow: 'Customer reported x; a chain of replies followed.',
      now: '2026-08-23T09:00:00.000Z',
    });
    assert.deepEqual(result.comments, [
      { id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait' },
      { id: 'c2', issue: 'x reply' },
      { id: 'c3', issue: 'x reply follow-up' },
    ]);
  });

  it('same-batch reply whose parent is in the same delta fed in newest-first order nests under its parent, not at top level', () => {
    const prior = {
      caseNumber: '08633581',
      status: 'Open',
      summarizedCommentIds: ['c1'],
      comments: [{ id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait' }],
      flow: 'Customer reported x.',
      lastSummarizedAt: '2026-08-22T10:00:00.000Z',
    };
    // c2 replies to c1 (old post); c3 replies to c2 (new, same batch).
    // Fed in newest-first order (c3 before c2).
    const result = mergeSummary(prior, {
      caseNumber: '08633581',
      status: 'Pending Qualcomm',
      newComments: [
        { id: 'c3', issue: 'x reply follow-up' },
        { id: 'c2', issue: 'x reply' },
      ],
      parentIdOf: { c2: 'c1', c3: 'c2' },
      flow: 'Customer reported x; a chain of replies followed.',
      now: '2026-08-23T09:00:00.000Z',
    });
    assert.deepEqual(result.comments, [
      { id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait' },
      { id: 'c2', issue: 'x reply' },
      { id: 'c3', issue: 'x reply follow-up' },
    ]);
  });

  it('same-batch reply to a same-batch top-level comment nests under its parent, not as top-level', () => {
    const prior = {
      caseNumber: '08633581',
      status: 'Open',
      summarizedCommentIds: ['c1'],
      comments: [{ id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait' }],
      flow: 'Customer reported x.',
      lastSummarizedAt: '2026-08-22T10:00:00.000Z',
    };
    // c2 is a new top-level comment (no parent); c3 replies to c2.
    // Fed in newest-first order (c3 before c2).
    const result = mergeSummary(prior, {
      caseNumber: '08633581',
      status: 'Pending Qualcomm',
      newComments: [
        { id: 'c3', issue: 'c2 reply' },
        { id: 'c2', issue: 'c2 top-level' },
      ],
      parentIdOf: { c3: 'c2' },
      flow: 'Customer reported x; new thread started with a reply.',
      now: '2026-08-23T09:00:00.000Z',
    });
    assert.deepEqual(result.comments, [
      { id: 'c2', issue: 'c2 top-level' },
      { id: 'c3', issue: 'c2 reply' },
      { id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait' },
    ]);
  });

  it('a comment lacking a dimension (e.g. plain acknowledgement) keeps only the fields it has', () => {
    const result = mergeSummary(null, {
      caseNumber: '08633581',
      status: 'Open',
      newComments: [{ id: 'c1', nextAction: 'will check and get back' }],
      flow: 'Ack received.',
      now: '2026-08-22T10:00:00.000Z',
    });
    assert.deepEqual(result.comments[0], { id: 'c1', nextAction: 'will check and get back' });
  });
});
