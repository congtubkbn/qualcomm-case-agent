// Tests for qualcomm-case-summary's summary.md renderer (pure, no mocking needed).
//     node --test tests/qualcomm_case_summary_render.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderSummaryMd } from '../.claude/skills/qualcomm-case-summary/scripts/render_summary.mjs';

const summary = {
  caseNumber: '08633581',
  status: 'Pending Qualcomm',
  summarizedCommentIds: ['c1', 'c2'],
  comments: [
    { id: 'c1', timestamp: 'Aug 5, 2026', author: 'Luyen Kieu Ba', issue: 'RRC setup fails', status: 'FAIL', nextAction: 'wait for Qualcomm' },
    { id: 'c2', timestamp: 'Aug 6, 2026', author: 'Qualcomm Engineer', nextAction: 'will check and get back' },
  ],
  flow: 'Customer reported an RRC setup failure; Qualcomm is investigating.',
  lastSummarizedAt: '2026-08-22T10:00:00.000Z',
};

describe('renderSummaryMd', () => {
  it('renders case number and status verbatim in the header', () => {
    const md = renderSummaryMd(summary);
    assert.match(md, /08633581/);
    assert.match(md, /Pending Qualcomm/);
  });

  it('renders comments newest-first (c2 before c1) without mutating the input', () => {
    const md = renderSummaryMd(summary);
    const idxC2 = md.indexOf('Qualcomm Engineer');
    const idxC1 = md.indexOf('Luyen Kieu Ba');
    assert.ok(idxC2 !== -1 && idxC1 !== -1);
    assert.ok(idxC2 < idxC1, 'newest comment (c2) must render before older comment (c1)');
    assert.deepEqual(summary.comments[0].id, 'c1', 'input array order must stay untouched');
  });

  it('renders the case flow narrative', () => {
    const md = renderSummaryMd(summary);
    assert.match(md, /Customer reported an RRC setup failure/);
  });

  it('omits fields a comment does not have (c2 has no issue/status) instead of forcing blanks', () => {
    const md = renderSummaryMd(summary);
    const c2Block = md.slice(md.indexOf('Qualcomm Engineer'), md.indexOf('Luyen Kieu Ba'));
    assert.doesNotMatch(c2Block, /Issue:/);
    assert.doesNotMatch(c2Block, /Status:/);
    assert.match(c2Block, /will check and get back/);
  });
});
