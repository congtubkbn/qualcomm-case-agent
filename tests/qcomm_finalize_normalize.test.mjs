// tests/qcomm_finalize_normalize.test.mjs
// Characterization tests for finalize_normalize.mjs's classifyRole and
// isBlacklistedTs — split out of finalize_case.mjs (#250) with no prior
// isolated coverage (only exercised indirectly, if at all, through
// render_case.mjs / normalizeComment). Pin current behavior, not a spec.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyRole, isBlacklistedTs } from '../.claude/skills/qcomm/scripts/finalize_normalize.mjs';

describe('classifyRole', () => {
  it('classifies by an author/company/context mention of Qualcomm', () => {
    assert.equal(classifyRole('Jane Doe', 'Qualcomm Technologies'), 'Qualcomm');
    assert.equal(classifyRole('jane.doe@qualcomm.com'), 'Qualcomm');
    assert.equal(classifyRole('jane.doe@qti.qualcomm.com'), 'Qualcomm');
    assert.equal(classifyRole('Jane Doe', '', 'QTI engineering'), 'Qualcomm');
  });

  it('classifies System from an author/company/context mention of system/automated process', () => {
    assert.equal(classifyRole('system'), 'System');
    assert.equal(classifyRole('Jane Doe', '', 'automated process'), 'System');
  });

  it('classifies by body salutation/signoff clues when author/company/context give no signal', () => {
    assert.equal(classifyRole('Someone', '', '', 'Dear Customer, please see attached logs.'), 'Qualcomm');
    assert.equal(classifyRole('Someone', '', '', 'Thanks for reaching out to the Qualcomm team.'), 'Qualcomm');
    assert.equal(classifyRole('Someone', '', '', 'Please advise.\n\nRegards,\nQualcomm Support'), 'Qualcomm');
    assert.equal(classifyRole('Someone', '', '', 'Dear Qualcomm, here is the log you requested.'), 'Customer');
  });

  it('defaults to Customer with no Qualcomm/System signal anywhere', () => {
    assert.equal(classifyRole('John Smith', 'Acme Corp', '', 'Here is the reproduction log.'), 'Customer');
  });
});

describe('isBlacklistedTs', () => {
  it('flags known Salesforce/Chatter UI tooltip noise strings', () => {
    assert.equal(isBlacklistedTs('Click for single-item view'), true);
    assert.equal(isBlacklistedTs('Expand Post'), true);
    assert.equal(isBlacklistedTs('12 Chatter Feed Items'), true);
    assert.equal(isBlacklistedTs('View more comments'), true);
    assert.equal(isBlacklistedTs('3 more comments'), true);
  });

  it('treats missing/non-string input as blacklisted', () => {
    assert.equal(isBlacklistedTs(''), true);
    assert.equal(isBlacklistedTs(null), true);
    assert.equal(isBlacklistedTs(undefined), true);
  });

  it('does not flag a genuine timestamp string', () => {
    assert.equal(isBlacklistedTs('12 days ago'), false);
    assert.equal(isBlacklistedTs('2026-08-20T10:30:00.000Z'), false);
  });
});
