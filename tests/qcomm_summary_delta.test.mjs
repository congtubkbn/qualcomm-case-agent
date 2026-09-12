// Tests for qcomm's delta computation (pure, no mocking needed).
//     node --test tests/qcomm_summary_delta.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeDelta } from '../.claude/skills/qcomm/scripts/run_summary.mjs';

describe('computeDelta', () => {
  it('first-ever run: no summarized ids yet -> delta is every comment', () => {
    const comments = [
      { id: 'c1', body: 'a' },
      { id: 'c2', body: 'b' },
    ];
    assert.deepEqual(computeDelta(comments, []), comments);
  });

  it('unchanged case: every comment already summarized -> delta is empty', () => {
    const comments = [
      { id: 'c1', body: 'a' },
      { id: 'c2', body: 'b' },
    ];
    assert.deepEqual(computeDelta(comments, ['c1', 'c2']), []);
  });

  it('update run: only new comment ids are in the delta, in case.json order', () => {
    const comments = [
      { id: 'c1', body: 'a' },
      { id: 'c2', body: 'b' },
      { id: 'c3', body: 'c' },
    ];
    assert.deepEqual(computeDelta(comments, ['c1']), [
      { id: 'c2', body: 'b' },
      { id: 'c3', body: 'c' },
    ]);
  });

  it('is a set difference by id, not affected by summarizedIds order or duplicates', () => {
    const comments = [
      { id: 'c1', body: 'a' },
      { id: 'c2', body: 'b' },
    ];
    assert.deepEqual(computeDelta(comments, ['c2', 'c2', 'c1']), []);
  });

  it('finds unsummarized replies nested in subs (any depth), not just top-level comments', () => {
    const comments = [
      {
        id: 'c1', body: 'a', subs: [
          { id: 'c2', body: 'reply to c1', subs: [
            { id: 'c3', body: 'reply to c2', subs: [] },
          ] },
        ],
      },
      { id: 'c4', body: 'top-level, unrelated', subs: [] },
    ];
    assert.deepEqual(computeDelta(comments, ['c1']), [
      { id: 'c2', body: 'reply to c1' },
      { id: 'c3', body: 'reply to c2' },
      { id: 'c4', body: 'top-level, unrelated' },
    ]);
  });
});
