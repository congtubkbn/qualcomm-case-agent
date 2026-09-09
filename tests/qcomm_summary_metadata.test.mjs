// Tests for qcomm's case-level metadata header + executive summary block.
//     node --test tests/qcomm_summary_metadata.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeSummary, renderSummaryMd } from '../.claude/skills/qcomm/scripts/run_summary.mjs';

describe('renderSummaryMd — case metadata header + executive summary', () => {
  it('full metadata + executive block renders all sections and links cleanly', () => {
    const md = renderSummaryMd({
      caseNumber: '08642051',
      title: '[P260803-02707] [SIDIA Ecall Test] SEAU_5G_IMS_Ecall_VoNR_redial_TC1_RTD',
      url: 'https://support.qualcomm.com/s/case/500dK00000OU6BqQAL/p26080302707',
      priority: '1 - Critical',
      product: 'SDX75',
      status: 'Closed-Customer Requested',
      executive: {
        ballInCourt: 'closed',
        blockerOrNextMilestone: 'Case resolved by customer',
        rootCause: 'Emergency service fallback ULInformationTransfer was not triggered on newer modem build 641',
        resolution: 'Disabled CR 4555226; test passes',
      },
      comments: [{ id: 'c1', timestamp: 't1', author: 'A', summary: 'x' }],
      flow: 'flow text',
    });

    assert.match(md, /^# \[08642051\] \[P260803-02707\] \[SIDIA Ecall Test\] SEAU_5G_IMS_Ecall_VoNR_redial_TC1_RTD$/m);
    assert.match(md, /^- \*\*Status\*\*: Closed-Customer Requested$/m);
    assert.match(md, /^- \*\*Priority\*\*: 1 - Critical$/m);
    assert.match(md, /^- \*\*Product\*\*: SDX75$/m);
    assert.match(md, /^- \*\*Portal\*\*: \[Open in Qualcomm Profile \(qc:\/\/\)\]\(qc:\/\/case\/08642051\)$/m);
    assert.doesNotMatch(md, /Web Link/);

    assert.match(md, /^## Executive Summary$/m);
    assert.match(md, /^- \*\*Ball in Court\*\*: Closed$/m);
    assert.match(md, /^- \*\*Next Milestone\*\*: Case resolved by customer$/m);
    assert.match(md, /^- \*\*Root Cause\*\*: Emergency service fallback ULInformationTransfer was not triggered on newer modem build 641$/m);
    assert.match(md, /^- \*\*Resolution\*\*: Disabled CR 4555226; test passes$/m);

    // Executive Summary must render above Case Flow
    assert.ok(md.indexOf('## Executive Summary') < md.indexOf('## Case Flow'));
  });

  it('renders dual link with search fallback when title is present but url is omitted in summary', () => {
    const md = renderSummaryMd({
      caseNumber: '08550063',
      title: '5G NR throughput drop',
      status: 'Open',
      comments: [{ id: 'c1', timestamp: 't1', author: 'A', issue: 'x' }],
      flow: 'flow text',
    });

    assert.match(md, /^- \*\*Portal\*\*: \[Open in Qualcomm Profile \(qc:\/\/\)\]\(qc:\/\/case\/08550063\)$/m);
    assert.doesNotMatch(md, /Web Link/);
  });

  it('minimal summary (missing title/priority/executive) renders gracefully matching legacy output format', () => {
    const md = renderSummaryMd({
      caseNumber: '08633581',
      status: 'Pending Qualcomm',
      comments: [{ id: 'c1', timestamp: 't1', author: 'A', issue: 'x' }],
      flow: 'flow text',
    });

    assert.match(md, /^# Case 08633581 — Pending Qualcomm$/m);
    assert.doesNotMatch(md, /\*\*Priority\*\*/);
    assert.doesNotMatch(md, /\*\*Product\*\*/);
    assert.doesNotMatch(md, /\*\*URL\*\*/);
    assert.doesNotMatch(md, /\*\*Portal\*\*/);
    assert.doesNotMatch(md, /## Executive Summary/);
    assert.doesNotMatch(md, /\n\n\n/, 'no stray blank-line runs from omitted sections');
  });
});

describe('mergeSummary — case metadata pass-through', () => {
  it('captures title/url/priority/product on first merge', () => {
    const result = mergeSummary(null, {
      caseNumber: '08642051',
      title: 'Case Title',
      url: 'https://support.qualcomm.com/s/case/x',
      priority: '1 - Critical',
      product: 'SDX75',
      status: 'Open',
      newComments: [{ id: 'c1', summary: 'x' }],
      flow: 'flow',
      now: '2026-08-23T00:00:00.000Z',
    });
    assert.equal(result.title, 'Case Title');
    assert.equal(result.url, 'https://support.qualcomm.com/s/case/x');
    assert.equal(result.priority, '1 - Critical');
    assert.equal(result.product, 'SDX75');
  });

  it('preserves existing metadata across an incremental run that omits it', () => {
    const prior = {
      caseNumber: '08642051',
      title: 'Case Title',
      url: 'https://support.qualcomm.com/s/case/x',
      priority: '1 - Critical',
      product: 'SDX75',
      status: 'Open',
      summarizedCommentIds: ['c1'],
      comments: [{ id: 'c1', summary: 'x' }],
      flow: 'flow',
      lastSummarizedAt: '2026-08-23T00:00:00.000Z',
    };
    const result = mergeSummary(prior, {
      caseNumber: '08642051',
      status: 'Pending Qualcomm',
      newComments: [{ id: 'c2', summary: 'y' }],
      flow: 'flow updated',
      now: '2026-08-24T00:00:00.000Z',
    });
    assert.equal(result.title, 'Case Title');
    assert.equal(result.url, 'https://support.qualcomm.com/s/case/x');
    assert.equal(result.priority, '1 - Critical');
    assert.equal(result.product, 'SDX75');
  });

  it('a blank scraped field (e.g. product "") does not blank out a previously known value', () => {
    const prior = { caseNumber: '08642051', product: 'SDX75', status: 'Open', comments: [], flow: '' };
    const result = mergeSummary(prior, {
      caseNumber: '08642051',
      product: '',
      status: 'Open',
      newComments: [],
      flow: 'flow',
      now: '2026-08-24T00:00:00.000Z',
    });
    assert.equal(result.product, 'SDX75');
  });

  it('preserves prior executive block when the new batch does not produce one', () => {
    const prior = {
      caseNumber: '08642051',
      status: 'Open',
      executive: { ballInCourt: 'qualcomm', blockerOrNextMilestone: 'waiting on logs' },
      comments: [],
      flow: '',
    };
    const result = mergeSummary(prior, {
      caseNumber: '08642051',
      status: 'Pending Qualcomm',
      newComments: [],
      flow: 'flow',
      now: '2026-08-24T00:00:00.000Z',
    });
    assert.deepEqual(result.executive, { ballInCourt: 'qualcomm', blockerOrNextMilestone: 'waiting on logs' });
  });

  it('replaces executive when the new batch produces an updated one', () => {
    const prior = {
      caseNumber: '08642051',
      status: 'Open',
      executive: { ballInCourt: 'qualcomm', blockerOrNextMilestone: 'waiting on logs' },
      comments: [],
      flow: '',
    };
    const result = mergeSummary(prior, {
      caseNumber: '08642051',
      status: 'Closed',
      newComments: [],
      flow: 'flow',
      executive: { ballInCourt: 'closed', blockerOrNextMilestone: 'Case resolved' },
      now: '2026-08-24T00:00:00.000Z',
    });
    assert.deepEqual(result.executive, { ballInCourt: 'closed', blockerOrNextMilestone: 'Case resolved' });
  });

  it('does not add metadata keys when neither prior nor new batch has them (legacy shape preserved)', () => {
    const result = mergeSummary(null, {
      caseNumber: '08633581',
      status: 'Open',
      newComments: [{ id: 'c1', issue: 'x' }],
      flow: 'flow',
      now: '2026-08-22T10:00:00.000Z',
    });
    assert.deepEqual(result, {
      caseNumber: '08633581',
      status: 'Open',
      summarizedCommentIds: ['c1'],
      comments: [{ id: 'c1', issue: 'x' }],
      flow: 'flow',
      lastSummarizedAt: '2026-08-22T10:00:00.000Z',
    });
  });
});
