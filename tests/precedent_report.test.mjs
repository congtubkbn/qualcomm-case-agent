// Unit tests for precedent_report.mjs's rendering/persistence — prior art:
// tests/qualcomm_case_summary_render.test.mjs testing render_summary.mjs's exported functions
// directly.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildReportFilename,
  persistPrecedentReport,
  renderPrecedentReportMd,
  slugify,
} from '../.claude/skills/qualcomm-issue-precedent/scripts/precedent_report.mjs';

describe('precedent_report: slugify', () => {
  it('lowercases, hyphenates, and trims punctuation', () => {
    assert.equal(slugify('VoLTE call drop during driving test!'), 'volte-call-drop-during-driving-test');
  });

  it('falls back to "issue" for empty/non-string input', () => {
    assert.equal(slugify(''), 'issue');
    assert.equal(slugify(undefined), 'issue');
  });

  it('caps length at 60 characters', () => {
    const long = 'a'.repeat(100);
    assert.equal(slugify(long).length, 60);
  });
});

describe('precedent_report: buildReportFilename', () => {
  it('combines the slug and a filesystem-safe timestamp', () => {
    const now = new Date('2026-09-04T05:21:14.123Z');
    assert.equal(buildReportFilename('VoLTE call drop', now), 'volte-call-drop-2026-09-04T05-21-14-123Z.md');
  });
});

describe('precedent_report: renderPrecedentReportMd', () => {
  it('renders header fields and a no-candidates note when candidates is empty', () => {
    const md = renderPrecedentReportMd({ issueTitle: 'VoLTE call drop', issueRepro: 'Drops during driving test.', query: 'VoLTE call drop', candidates: [] });
    assert.match(md, /^# Precedent Check — VoLTE call drop/);
    assert.match(md, /\*\*Repro\*\*: Drops during driving test\./);
    assert.match(md, /\*\*Query\*\*: VoLTE call drop/);
    assert.match(md, /No reference cases matched this issue\./);
  });

  it('renders a candidate with checked signatures and their outcomes', () => {
    const md = renderPrecedentReportMd({
      issueTitle: 'VoLTE call drop',
      candidates: [
        {
          caseNumber: '08603854',
          title: 'VoLTE call drop during driving test',
          url: 'https://support.qualcomm.com/s/case/500dK00000Njp7aQAB',
          product: 'SM7635',
          score: 9,
          rootCause: 'RRC_CONN_RELEASE sent prematurely by network',
          resolution: 'CR1234 fix delivered',
          flow: 'Investigated modem logs.',
          signatures: [
            { signature: 'RRC_CONN_RELEASE', source: 'rootCause' },
            { signature: 'NAS_MSG_TYPE', source: 'comment:c1' },
            { signature: 'EPSFB', source: 'comment:c2' },
          ],
          selections: [{ signature: 'RRC_CONN_RELEASE', table: 'signalling' }, { signature: 'NAS_MSG_TYPE', table: 'trace' }],
          checks: [
            { signature: 'RRC_CONN_RELEASE', table: 'signalling', source: 'rootCause', result: { matched: true, evidence: ['hit at t=12.3s'] } },
            { signature: 'NAS_MSG_TYPE', table: 'trace', source: 'comment:c1', result: { matched: false, evidence: ['no hit in trace window'] } },
          ],
          verdict: 'matched known cause',
        },
      ],
    });

    assert.match(md, /### \[08603854\] VoLTE call drop during driving test — matched known cause/);
    assert.match(md, /\*\*Score\*\*: 9/);
    assert.match(md, /\*\*Product\*\*: SM7635/);
    assert.match(md, /\*\*Root Cause\*\*: RRC_CONN_RELEASE sent prematurely by network/);
    assert.match(md, /`RRC_CONN_RELEASE` \(table: signalling, source: rootCause\) → matched \(evidence: hit at t=12\.3s\)/);
    assert.match(md, /`NAS_MSG_TYPE` \(table: trace, source: comment:c1\) → not matched \(evidence: no hit in trace window\)/);
    assert.match(md, /\*\*Other extracted signatures \(not checked\):\*\* `EPSFB`/);
  });

  it('flags a low-confidence candidate in its rendered header', () => {
    const md = renderPrecedentReportMd({
      issueTitle: 'Some issue',
      candidates: [
        {
          caseNumber: '08999999',
          title: 'Loosely related case',
          score: 0,
          lowConfidence: true,
          signatures: [],
          checks: [],
          verdict: 'insufficient technical data to check',
        },
      ],
    });
    assert.match(md, /\*\*Score\*\*: 0/);
    assert.match(md, /\*\*Low confidence\*\*/);
  });

  it('flags candidates with no extractable signature as suggestion-only', () => {
    const md = renderPrecedentReportMd({
      issueTitle: 'Some issue',
      candidates: [{ caseNumber: '08111111', title: 'Untitled precedent', signatures: [], checks: [], verdict: 'insufficient technical data to check' }],
    });
    assert.match(md, /No extractable technical signature — suggestion only, not verified against the log\./);
  });
});

describe('precedent_report: persistPrecedentReport', () => {
  it('creates the precedent directory and writes a named Markdown file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qc-precedent-'));
    const precedentDir = join(dir, '_precedent');
    const now = new Date('2026-09-04T05:21:14.000Z');

    const { reportPath } = persistPrecedentReport(
      { issueTitle: 'VoLTE call drop', query: 'VoLTE call drop', candidates: [] },
      precedentDir,
      now
    );

    assert.ok(existsSync(reportPath));
    assert.equal(reportPath, join(precedentDir, 'volte-call-drop-2026-09-04T05-21-14-000Z.md'));
    const content = readFileSync(reportPath, 'utf8');
    assert.match(content, /# Precedent Check — VoLTE call drop/);
    assert.match(content, /\*\*Generated\*\*: 2026-09-04T05:21:14\.000Z/);

    rmSync(dir, { recursive: true, force: true });
  });
});
