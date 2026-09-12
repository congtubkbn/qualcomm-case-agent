// Tests for qcomm's merge logic (pure, no mocking needed).
//     node --test tests/qcomm_summary_merge.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeSummary } from '../.claude/skills/qcomm/scripts/run_summary.mjs';

describe('mergeSummary', () => {
  it('first-ever merge: no prior summary -> summarizedCommentIds/comments start from the new batch, nested (subs:[])', () => {
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
      comments: [{ id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait', subs: [] }],
      flow: 'Customer reported x.',
      lastSummarizedAt: '2026-08-22T10:00:00.000Z',
    });
  });

  it('update merge: no parent info -> new top-level comment appended oldest->newest, ids unioned', () => {
    const prior = {
      caseNumber: '08633581',
      status: 'Open',
      summarizedCommentIds: ['c1'],
      comments: [{ id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait', subs: [] }],
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
      { id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait', subs: [] },
      { id: 'c2', issue: 'y', nextAction: 'escalate', subs: [] },
    ]);
    assert.equal(result.status, 'Pending Qualcomm');
    assert.equal(result.flow, 'Customer reported x; Qualcomm asked for logs.');
    assert.equal(result.lastSummarizedAt, '2026-08-23T09:00:00.000Z');
    // prior object itself must not be mutated
    assert.deepEqual(prior.summarizedCommentIds, ['c1']);
    assert.deepEqual(prior.comments, [{ id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait', subs: [] }]);
  });

  it('reply to an already-summarized old post nests into that parent\'s subs, not appended top-level', () => {
    const prior = {
      caseNumber: '08633581',
      status: 'Open',
      summarizedCommentIds: ['c1', 'c2'],
      comments: [
        { id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait', subs: [] },
        { id: 'c2', issue: 'y', nextAction: 'escalate', subs: [] },
      ],
      flow: 'Customer reported x; Qualcomm asked for logs.',
      lastSummarizedAt: '2026-08-23T09:00:00.000Z',
    };
    // c3 is a reply to c1 (the older post) — not to c2 (the newer one).
    const result = mergeSummary(prior, {
      caseNumber: '08633581',
      status: 'Pending Qualcomm',
      newComments: [{ id: 'c3', issue: 'x follow-up', nextAction: 'attach logs' }],
      parentIdOf: { c3: 'c1' },
      flow: 'Customer reported x; Qualcomm asked for logs; customer attached logs.',
      now: '2026-08-24T09:00:00.000Z',
    });
    assert.deepEqual(result.comments, [
      { id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait', subs: [
        { id: 'c3', issue: 'x follow-up', nextAction: 'attach logs', subs: [] },
      ] },
      { id: 'c2', issue: 'y', nextAction: 'escalate', subs: [] },
    ]);
    assert.deepEqual(result.summarizedCommentIds, ['c1', 'c2', 'c3']);
  });

  it('two same-batch replies to the same already-summarized parent land oldest->newest inside its subs', () => {
    const prior = {
      caseNumber: '08633581',
      status: 'Open',
      summarizedCommentIds: ['c1'],
      comments: [{ id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait', subs: [] }],
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
      { id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait', subs: [
        { id: 'c2', issue: 'x older reply', subs: [] },
        { id: 'c3', issue: 'x newer reply', subs: [] },
      ] },
    ]);
  });

  it('a reply to a comment that is itself new in the same batch nests two levels deep', () => {
    const prior = {
      caseNumber: '08633581',
      status: 'Open',
      summarizedCommentIds: ['c1'],
      comments: [{ id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait', subs: [] }],
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
      { id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait', subs: [
        { id: 'c2', issue: 'x reply', subs: [
          { id: 'c3', issue: 'x reply follow-up', subs: [] },
        ] },
      ] },
    ]);
  });

  it('same-batch reply whose parent is in the same delta fed newest-first still resolves into the parent\'s subs', () => {
    const prior = {
      caseNumber: '08633581',
      status: 'Open',
      summarizedCommentIds: ['c1'],
      comments: [{ id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait', subs: [] }],
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
      { id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait', subs: [
        { id: 'c2', issue: 'x reply', subs: [
          { id: 'c3', issue: 'x reply follow-up', subs: [] },
        ] },
      ] },
    ]);
  });

  it('same-batch reply to a same-batch top-level comment nests under it, not appended top-level itself', () => {
    const prior = {
      caseNumber: '08633581',
      status: 'Open',
      summarizedCommentIds: ['c1'],
      comments: [{ id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait', subs: [] }],
      flow: 'Customer reported x.',
      lastSummarizedAt: '2026-08-22T10:00:00.000Z',
    };
    // c2 is a new top-level comment (no parent); c3 replies to c2.
    // Fed newest-first (c3 before c2).
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
      { id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait', subs: [] },
      { id: 'c2', issue: 'c2 top-level', subs: [
        { id: 'c3', issue: 'c2 reply', subs: [] },
      ] },
    ]);
  });

  it('a comment lacking a dimension (e.g. plain acknowledgement) keeps only the fields it has, plus subs:[]', () => {
    const result = mergeSummary(null, {
      caseNumber: '08633581',
      status: 'Open',
      newComments: [{ id: 'c1', nextAction: 'will check and get back' }],
      flow: 'Ack received.',
      now: '2026-08-22T10:00:00.000Z',
    });
    assert.deepEqual(result.comments[0], { id: 'c1', nextAction: 'will check and get back', subs: [] });
  });

  it('legacy flat prior comments (pre-#235, no subs field) get re-nested via parentIdOf alongside newly-merged replies', () => {
    // Pre-#235 summary.json stored comments as a flat array with no subs/parentId at
    // all -- c2 is actually a reply to c1, but that link was never persisted.
    const prior = {
      caseNumber: '08633581',
      status: 'Open',
      summarizedCommentIds: ['c1', 'c2'],
      comments: [
        { id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait' },
        { id: 'c2', issue: 'x follow-up', nextAction: 'wait more' },
      ],
      flow: 'Customer reported x; followed up.',
      lastSummarizedAt: '2026-08-23T09:00:00.000Z',
    };
    const result = mergeSummary(prior, {
      caseNumber: '08633581',
      status: 'Pending Qualcomm',
      newComments: [{ id: 'c3', issue: 'x follow-up 2' }],
      // finalize() derives parentIdOf from the full case.json tree, so it covers c2
      // (already summarized) as well as the brand-new c3.
      parentIdOf: { c2: 'c1', c3: 'c1' },
      flow: 'Customer reported x; followed up twice.',
      now: '2026-08-24T09:00:00.000Z',
    });
    assert.deepEqual(result.comments, [
      { id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait', subs: [
        { id: 'c2', issue: 'x follow-up', nextAction: 'wait more', subs: [] },
        { id: 'c3', issue: 'x follow-up 2', subs: [] },
      ] },
    ]);
  });

  it('legacy flat prior comments stored newest-batch-first get reordered to oldest-first using commentOrder from case.json', () => {
    // Pre-#235 finalize prepended each new batch, so a real legacy summary.json's
    // top-level array is newest-batch-first: c3 (a later, unrelated top-level batch)
    // sits before c1/c2 even though c1 is chronologically first and c2 replies to it.
    const prior = {
      caseNumber: '08633581',
      status: 'Open',
      summarizedCommentIds: ['c1', 'c2', 'c3'],
      comments: [
        { id: 'c3', issue: 'unrelated later post' },
        { id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait' },
        { id: 'c2', issue: 'x follow-up', nextAction: 'wait more' },
      ],
      flow: 'Customer reported x; followed up; unrelated later post.',
      lastSummarizedAt: '2026-08-23T09:00:00.000Z',
    };
    const result = mergeSummary(prior, {
      caseNumber: '08633581',
      status: 'Pending Qualcomm',
      newComments: [],
      parentIdOf: { c2: 'c1' },
      // finalize() derives this from walkCommentTree(caseJson.comments) -- the true
      // oldest-first order, independent of how legacy summary.json happened to store it.
      commentOrder: ['c1', 'c2', 'c3'],
      flow: 'Customer reported x; followed up; unrelated later post.',
      now: '2026-08-24T09:00:00.000Z',
    });
    assert.deepEqual(result.comments, [
      { id: 'c1', issue: 'x', status: 'PASS', nextAction: 'wait', subs: [
        { id: 'c2', issue: 'x follow-up', nextAction: 'wait more', subs: [] },
      ] },
      { id: 'c3', issue: 'unrelated later post', subs: [] },
    ]);
  });

  it('a reply whose parent is unresolvable (not in prior tree or same batch) falls back to top-level', () => {
    const prior = {
      caseNumber: '08633581',
      status: 'Open',
      summarizedCommentIds: ['c1'],
      comments: [{ id: 'c1', issue: 'x', subs: [] }],
      flow: 'Customer reported x.',
      lastSummarizedAt: '2026-08-22T10:00:00.000Z',
    };
    const result = mergeSummary(prior, {
      caseNumber: '08633581',
      status: 'Pending Qualcomm',
      newComments: [{ id: 'c9', issue: 'orphan reply' }],
      parentIdOf: { c9: 'does-not-exist' },
      flow: 'flow',
      now: '2026-08-23T09:00:00.000Z',
    });
    assert.deepEqual(result.comments, [
      { id: 'c1', issue: 'x', subs: [] },
      { id: 'c9', issue: 'orphan reply', subs: [] },
    ]);
  });
});
