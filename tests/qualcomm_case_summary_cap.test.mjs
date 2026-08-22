// Tests for qualcomm-case-summary's character-cap guard (pure, no mocking needed).
//     node --test tests/qualcomm_case_summary_cap.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyCharCap, applyCharCapToComments, CHAR_CAP } from '../.claude/skills/qualcomm-case-summary/scripts/cap.mjs';

describe('applyCharCap', () => {
  it('leaves a body under the cap untouched', () => {
    assert.equal(applyCharCap('short body'), 'short body');
  });

  it('is a hard truncation, not detection: cuts a body over the cap at exactly CHAR_CAP chars', () => {
    const oversized = 'x'.repeat(CHAR_CAP + 500);
    const capped = applyCharCap(oversized);
    assert.equal(capped.length, CHAR_CAP);
    assert.equal(capped, 'x'.repeat(CHAR_CAP));
  });

  it('applies the same cap to every comment body in a delta array, leaving other fields untouched', () => {
    const oversized = 'y'.repeat(CHAR_CAP + 10);
    const delta = [
      { id: 'c1', author: 'A', body: 'short' },
      { id: 'c2', author: 'B', body: oversized },
    ];
    const capped = applyCharCapToComments(delta);
    assert.equal(capped[0].body, 'short');
    assert.equal(capped[0].author, 'A');
    assert.equal(capped[1].body.length, CHAR_CAP);
    assert.equal(capped[1].author, 'B');
  });
});
