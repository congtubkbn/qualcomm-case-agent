// Tests for qualcomm-case-summary's summary.md renderer (pure, no mocking needed).
//     node --test tests/qualcomm_case_summary_render.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderSummaryMd } from '../.claude/skills/qualcomm-case-summary/scripts/run_summary.mjs';

const summary = {
  caseNumber: '08633581',
  status: 'Pending Qualcomm',
  summarizedCommentIds: ['c1', 'c2'],
  // newest-first: c2 (Aug 6) is newer than c1 (Aug 5).
  comments: [
    { id: 'c2', timestamp: 'Aug 6, 2026', author: 'Qualcomm Engineer', nextAction: 'will check and get back' },
    { id: 'c1', timestamp: 'Aug 5, 2026', author: 'Luyen Kieu Ba', issue: 'RRC setup fails', status: 'FAIL', nextAction: 'wait for Qualcomm' },
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
    assert.deepEqual(summary.comments[0].id, 'c2', 'input array order must stay untouched');
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

describe('renderSummaryMd — six-field comment schema', () => {
  it('renders all six new fields when present', () => {
    const md = renderSummaryMd({
      caseNumber: '08642051',
      status: 'Open',
      comments: [{
        id: 'c9', timestamp: 'Aug 20, 2026', author: 'Qualcomm Engineer',
        kind: 'bug-report', summary: 'RRC setup fails on retry.', impact: 'blocker-introduced',
        owner: 'qualcomm', nextAction: 'Qualcomm to reproduce', references: ['c7', 'c8'],
      }],
      flow: 'flow text',
    });
    assert.match(md, /^- Kind: bug-report$/m);
    assert.match(md, /^- Summary: RRC setup fails on retry\.$/m);
    assert.match(md, /^- Impact: blocker-introduced$/m);
    assert.match(md, /^- Owner: qualcomm$/m);
    assert.match(md, /^- Next action: Qualcomm to reproduce$/m);
    assert.match(md, /^- References: c7, c8$/m);
  });

  it('renders only present fields (kind + nextAction) with no blank lines for omitted ones', () => {
    const md = renderSummaryMd({
      caseNumber: '08642051',
      status: 'Open',
      comments: [{
        id: 'c9', timestamp: 'Aug 20, 2026', author: 'Qualcomm Engineer',
        kind: 'acknowledgment', nextAction: 'awaiting reply',
      }],
      flow: 'flow text',
    });
    const block = md.slice(md.indexOf('### Qualcomm Engineer'));
    assert.match(block, /- Kind: acknowledgment/);
    assert.match(block, /- Next action: awaiting reply/);
    assert.doesNotMatch(block, /Summary:/);
    assert.doesNotMatch(block, /Impact:/);
    assert.doesNotMatch(block, /Owner:/);
    assert.doesNotMatch(block, /References:/);
    assert.doesNotMatch(block, /\n\n- /, 'no blank line between rendered field lines');
  });

  it('renders an old-shape comment (issue/status, no kind/impact) without crashing', () => {
    const md = renderSummaryMd({
      caseNumber: '08633581',
      status: 'Pending Qualcomm',
      comments: [{
        id: 'c1', timestamp: 'Aug 5, 2026', author: 'Luyen Kieu Ba',
        issue: 'RRC setup fails', status: 'FAIL', nextAction: 'wait for Qualcomm',
      }],
      flow: 'flow text',
    });
    assert.match(md, /- Issue: RRC setup fails/);
    assert.match(md, /- Status: FAIL/);
    assert.match(md, /- Next action: wait for Qualcomm/);
  });

  it('omits References entirely when absent', () => {
    const md = renderSummaryMd({
      caseNumber: '08642051',
      status: 'Open',
      comments: [{ id: 'c9', timestamp: 'Aug 20, 2026', author: 'Qualcomm Engineer', summary: 'no refs here' }],
      flow: 'flow text',
    });
    assert.doesNotMatch(md, /References:/);
  });

  it('renders initial description comment (problem-statement / reporter) cleanly in summary comments flow', () => {
    const md = renderSummaryMd({
      caseNumber: '08642051',
      title: 'NR SA attach failure',
      status: 'Open',
      comments: [
        {
          id: 'c0',
          timestamp: 'Aug 18, 2026',
          author: 'OEM-Alpha',
          kind: 'problem-statement',
          summary: 'UE fails registration on n78 standalone cell during initial attach.',
          impact: 'blocker',
          owner: 'reporter',
        },
        {
          id: 'c1',
          timestamp: 'Aug 19, 2026',
          author: 'Qualcomm Engineer',
          kind: 'investigation',
          summary: 'Requested QXDM logs with mask 0xB0C0.',
          nextAction: 'OEM to provide logs',
        },
      ],
      flow: 'Customer reported an NR SA attach failure on n78; Qualcomm requested QXDM logs.',
    });
    assert.match(md, /### OEM-Alpha \(Aug 18, 2026\)/);
    assert.match(md, /- Kind: problem-statement/);
    assert.match(md, /- Summary: UE fails registration on n78 standalone cell during initial attach\./);
    assert.match(md, /- Impact: blocker/);
    assert.match(md, /- Owner: reporter/);
  });
});
