// Tests for qcomm's summary.md renderer (pure, no mocking needed).
//     node --test tests/qcomm_summary_render.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderSummaryMd } from '../.claude/skills/qcomm/scripts/run_summary.mjs';

const summary = {
  caseNumber: '08633581',
  status: 'Pending Qualcomm',
  summarizedCommentIds: ['c1', 'c2'],
  // oldest-first, matching case.json/case.md's nested-tree convention (#233/#234).
  comments: [
    { id: 'c1', timestamp: 'Aug 5, 2026', author: 'Luyen Kieu Ba', issue: 'RRC setup fails', status: 'FAIL', nextAction: 'wait for Qualcomm', subs: [] },
    { id: 'c2', timestamp: 'Aug 6, 2026', author: 'Qualcomm Engineer', nextAction: 'will check and get back', subs: [] },
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

  it('renders comments oldest-first (c1 before c2) with hierarchical numbering, without mutating the input', () => {
    const md = renderSummaryMd(summary);
    const idxC1 = md.indexOf('Luyen Kieu Ba');
    const idxC2 = md.indexOf('Qualcomm Engineer');
    assert.ok(idxC1 !== -1 && idxC2 !== -1);
    assert.ok(idxC1 < idxC2, 'older comment (c1) must render before newer comment (c2)');
    assert.match(md, /### 1\. Luyen Kieu Ba \(Aug 5, 2026\)/);
    assert.match(md, /### 2\. Qualcomm Engineer \(Aug 6, 2026\)/);
    assert.deepEqual(summary.comments[0].id, 'c1', 'input array order must stay untouched');
  });

  it('renders the case flow narrative', () => {
    const md = renderSummaryMd(summary);
    assert.match(md, /Customer reported an RRC setup failure/);
  });

  it('omits fields a comment does not have (c2 has no issue/status) instead of forcing blanks', () => {
    const md = renderSummaryMd(summary);
    const c2Block = md.slice(md.indexOf('### 2. Qualcomm Engineer'));
    assert.doesNotMatch(c2Block, /Issue:/);
    assert.doesNotMatch(c2Block, /Status:/);
    assert.match(c2Block, /will check and get back/);
  });

  it('marks a nested reply with the same ↳ marker used by case.md, numbered under its parent', () => {
    const md = renderSummaryMd({
      caseNumber: '08642051',
      status: 'Open',
      comments: [
        { id: 'c1', timestamp: 't1', author: 'A', issue: 'top', subs: [
          { id: 'c2', timestamp: 't2', author: 'B', issue: 'reply', subs: [] },
        ] },
      ],
      flow: 'flow text',
    });
    assert.match(md, /### 1\. A \(t1\)/);
    assert.match(md, /### 1\.1\. ↳ B \(t2\)/);
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
    const block = md.slice(md.indexOf('### 1. Qualcomm Engineer'));
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
    assert.match(md, /### 1\. OEM-Alpha \(Aug 18, 2026\)/);
    assert.match(md, /- Kind: problem-statement/);
    assert.match(md, /- Summary: UE fails registration on n78 standalone cell during initial attach\./);
    assert.match(md, /- Impact: blocker/);
    assert.match(md, /- Owner: reporter/);
  });
});
