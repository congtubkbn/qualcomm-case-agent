// Tests for qualcomm-case-summary's merge logic (pure, no mocking needed).
//     node --test tests/qualcomm_case_summary_merge.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeSummary } from '../.claude/skills/qualcomm-case-summary/scripts/merge.mjs';

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

  it('update merge: prior summaries preserved unchanged, new ones appended, ids unioned', () => {
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
      { id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait' },
      { id: 'c2', issue: 'y', nextAction: 'escalate' },
    ]);
    assert.equal(result.status, 'Pending Qualcomm');
    assert.equal(result.flow, 'Customer reported x; Qualcomm asked for logs.');
    assert.equal(result.lastSummarizedAt, '2026-08-23T09:00:00.000Z');
    // prior object itself must not be mutated
    assert.deepEqual(prior.summarizedCommentIds, ['c1']);
    assert.deepEqual(prior.comments, [{ id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait' }]);
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
