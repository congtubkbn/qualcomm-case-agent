// QA coverage for render_case.mjs
// Tests that render_case.mjs generates ONLY case.md (clean markdown)
// with Header metadata, Initial Description, and Chronological Timeline of comments,
// without generating HTML, PDF, txt, or report.md files.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../.claude/skills/qualcomm-case-agent/scripts/render_case.mjs', import.meta.url));

function renderFixture(data) {
  const dir = mkdtempSync(join(tmpdir(), 'qc-render-'));
  const jsonPath = join(dir, 'case.json');
  writeFileSync(jsonPath, typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
  const r = spawnSync(process.execPath, [SCRIPT, jsonPath], { encoding: 'utf8' });
  return {
    dir,
    exit: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    hasFile: (name) => existsSync(join(dir, name)),
    md: () => readFileSync(join(dir, 'case.md'), 'utf8'),
  };
}

const comment = (author, body, extra = {}) => ({ author, body, timestamp: '2 days ago', ...extra });

const MINIMAL = {
  caseNumber: '08460319',
  title: 'NR SA attach failure',
  status: 'Open',
  priority: 'P2',
  comments: [comment('Alice', 'RRC reject on n78')],
};

describe('render_case: output artifacts', () => {
  it('generates ONLY case.md and does NOT generate case.html, case.report.md, or case.txt', () => {
    const r = renderFixture(MINIMAL);
    assert.equal(r.exit, 0);
    assert.ok(r.hasFile('case.md'), 'case.md must be generated');
    assert.ok(!r.hasFile('case.html'), 'case.html must NOT be generated');
    assert.ok(!r.hasFile('case.report.md'), 'case.report.md must NOT be generated');
    assert.ok(!r.hasFile('case.txt'), 'case.txt must NOT be generated');
    assert.ok(!r.hasFile('case.pdf'), 'case.pdf must NOT be generated');
  });
});

describe('render_case: case.md content structure', () => {
  it('renders complete markdown with metadata, description, chronological comments, logs and attachments', () => {
    const fullCase = {
      caseNumber: '08460319',
      title: 'NR SA attach failure on band n78',
      status: 'In Progress',
      priority: 'P1',
      severity: 'S1',
      product: 'Snapdragon X75',
      component: 'Modem RF',
      customer: 'OEM-Alpha',
      url: 'https://support.qualcomm.com/case/08460319',
      created: '2026-08-18T08:00:00.000Z',
      updated: '2026-08-20T14:30:00.000Z',
      extractedAt: '2026-08-22T00:00:00.000Z',
      description: 'UE fails registration on n78 standalone cell during initial attach.',
      comments: [
        comment('OEM-Alpha', 'UE fails registration on n78 standalone cell during initial attach.', {
          id: 'c0',
          timestamp: '2026-08-18T08:00:00.000Z',
          summary: 'UE fails registration on n78 standalone cell during initial attach.',
        }),
        comment('Alice', 'Initial case filing with issue description.', {
          id: 'c1',
          timestamp: '2026-08-18T08:30:00.000Z',
          summary: 'Initial case filing with issue description.',
          attachments: [
            { name: 'modem_boot.pcap', href: 'https://support.qualcomm.com/f/pcap123' },
          ],
        }),
        comment('Qualcomm Support', 'Dear customer,\nPlease provide QXDM log with 0xB0C0 message mask.', {
          id: 'c2',
          timestamp: '2026-08-19T10:15:00.000Z',
          summary: 'Please provide QXDM log with 0xB0C0 message mask.',
          attachments: [
            { name: 'mask_config.cfg', href: 'https://support.qualcomm.com/f/cfg123' },
            { name: 'readme.txt', href: 'https://support.qualcomm.com/f/txt123' },
          ],
        }),
      ],
    };

    const r = renderFixture(fullCase);
    assert.equal(r.exit, 0);
    const md = r.md();

    // 1. Metadata assertions — table-formatted
    assert.match(md, /# 08460319 — NR SA attach failure on band n78/);
    assert.match(md, /\| Field \| Value \|/);
    assert.match(md, /\| --- \| --- \|/);
    assert.match(md, /\| Status \| In Progress \|/);
    assert.match(md, /\| Priority \| P1 \|/);
    assert.match(md, /\| Severity \| S1 \|/);
    assert.match(md, /\| Product \| Snapdragon X75 \|/);
    assert.match(md, /\| Component \| Modem RF \|/);
    assert.match(md, /\| Customer \| OEM-Alpha \|/);
    assert.match(md, /\| Created \| 2026-08-18T08:00:00\.000Z \|/);
    assert.match(md, /\| Updated \| 2026-08-20T14:30:00\.000Z \|/);
    assert.match(md, /\| Comments \| 3 \|/);
    assert.match(md, /\| Synced \| 2026-08-22T00:00:00\.000Z \|/);
    assert.match(md, /- \*\*URL:\*\* https:\/\/support\.qualcomm\.com\/case\/08460319/);

    // 2. Standalone Description section is NOT rendered
    assert.doesNotMatch(md, /^## Description$/m, 'Standalone ## Description section must be removed to avoid duplication');

    // 3. Chronological timeline of comments with description comment as #1
    assert.match(md, /## Chronological Timeline of Comments/);
    assert.match(md, /### 1\. 2026-08-18T08:00:00\.000Z · OEM-Alpha/);
    assert.match(md, /UE fails registration on n78 standalone cell during initial attach\./);

    assert.match(md, /### 2\. 2026-08-18T08:30:00\.000Z · Alice/);
    assert.match(md, /Initial case filing with issue description\./);
    assert.match(md, /\*\*Attachments:\*\* \[modem_boot\.pcap\]\(https:\/\/support\.qualcomm\.com\/f\/pcap123\)/);

    assert.match(md, /### 3\. 2026-08-19T10:15:00\.000Z · Qualcomm Support/);
    assert.match(md, /> \*\*Summary:\*\* Please provide QXDM log with 0xB0C0 message mask\./);
    assert.match(md, /Please provide QXDM log with 0xB0C0 message mask\./);
    assert.match(md, /\*\*Attachments:\*\* \[mask_config\.cfg\]\(https:\/\/support\.qualcomm\.com\/f\/cfg123\), \[readme\.txt\]\(https:\/\/support\.qualcomm\.com\/f\/txt123\)/);
  });

  it('renders Salesforce Detail tab metadata (Contact Name, Customer Project, Date Opened, Date Closed, Related CRs, Case Record Type)', () => {
    const detailCase = {
      caseNumber: '08550063',
      title: '5G NR throughput drop on SA network',
      status: 'Open',
      priority: 'P2',
      product: 'SM7635',
      contactName: 'Mai Ngoc',
      customerProject: 'Titan-5G',
      accountName: 'OEM-Alpha',
      customer: 'OEM-Alpha',
      caseRecordType: 'External Case',
      relatedCRs: 'CR3798678, CR3801234',
      openedAt: '2026-08-18 10:00',
      closedAt: '2026-08-20 15:30',
      created: '2026-08-18 10:00',
      updated: '2026-08-20 15:30',
      comments: [
        comment('Mai Ngoc', 'Initial issue description with logs.'),
      ],
    };

    const r = renderFixture(detailCase);
    assert.equal(r.exit, 0);
    const md = r.md();

    assert.match(md, /\| Contact Name \| Mai Ngoc \|/);
    assert.match(md, /\| Customer Project \| Titan-5G \|/);
    assert.match(md, /\| Date Opened \| 2026-08-18 10:00 \|/);
    assert.match(md, /\| Date Closed \| 2026-08-20 15:30 \|/);
    assert.match(md, /\| Case Record Type \| External Case \|/);
    assert.match(md, /\| Related CRs \| CR3798678, CR3801234 \|/);
  });

  it('does not render obsolete enrichment / LLM sections', () => {
    const caseWithEnrich = {
      ...MINIMAL,
      enrichment: {
        engineerSummary: 'UE registration fails due to RACH preamble timeout.',
        currentStatus: 'Qualcomm requested modem QXDM logs with 0xB0C0 mask.',
        rootCause: 'Timing advance misconfiguration in gNB SIB1.',
        caseFlow: [{ phase: 'Triage', date: '2026-08-20', by: 'Engineer A', what: 'Analyzed initial crash dump' }],
        openQuestions: ['Is SIB1 periodicity set to 20ms?'],
        recommendedActions: ['Provide full QXDM binary log from bootup.'],
        tags: ['5G-SA', 'n78', 'Attach-Failure'],
      },
    };

    const r = renderFixture(caseWithEnrich);
    assert.equal(r.exit, 0);
    const md = r.md();

    assert.ok(!md.includes('Engineer Summary'));
    assert.ok(!md.includes('Current Status'));
    assert.ok(!md.includes('Root Cause'));
    assert.ok(!md.includes('Analysis Flow'));
    assert.ok(!md.includes('Open Questions'));
    assert.ok(!md.includes('Recommended Actions'));
    assert.ok(!md.includes('5G-SA'));
  });

  it('renders attachments having url property instead of href', () => {
    const caseWithUrlAtt = {
      ...MINIMAL,
      comments: [
        comment('Alice', 'Attached logs with url.', {
          attachments: [{ name: 'crash.bin', url: 'https://support.qualcomm.com/download/crash.bin' }],
        }),
      ],
    };

    const r = renderFixture(caseWithUrlAtt);
    assert.equal(r.exit, 0);
    assert.match(r.md(), /\*\*Attachments:\*\* \[crash\.bin\]\(https:\/\/support\.qualcomm\.com\/download\/crash\.bin\)/);
  });

  it('exits 2 with a usage message when no path is given', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage:/);
  });
});

describe('render_case: malformed / missing data tolerance', () => {
  it('tolerates a case with no comments array at all', () => {
    const { comments, ...noComments } = MINIMAL;
    const r = renderFixture(noComments);
    assert.equal(r.exit, 0);
    assert.match(r.md(), /Chronological Timeline of Comments/);
  });

  it('tolerates an empty comments array', () => {
    const r = renderFixture({ ...MINIMAL, comments: [] });
    assert.equal(r.exit, 0);
    assert.match(r.md(), /Chronological Timeline of Comments/);
  });

  it('tolerates missing optional header fields', () => {
    const r = renderFixture({ caseNumber: '08460319', title: 'x', comments: [comment('A', 'b')] });
    assert.equal(r.exit, 0);
    assert.ok(!r.md().includes('| Status |'));
    assert.ok(!r.md().includes('| Product |'));
  });

  it('falls back to "Untitled case" when title is missing', () => {
    const { title, ...noTitle } = MINIMAL;
    const r = renderFixture(noTitle);
    assert.equal(r.exit, 0);
    assert.match(r.md(), /Untitled case/);
  });

  it('reads a UTF-8 BOM-prefixed case.json', () => {
    const r = renderFixture('\uFEFF' + JSON.stringify(MINIMAL));
    assert.equal(r.exit, 0);
    assert.match(r.md(), /08460319/);
  });

  it('exits non-zero on malformed JSON without writing partial artifacts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qc-render-'));
    const jsonPath = join(dir, 'case.json');
    writeFileSync(jsonPath, '{ not valid json', 'utf8');
    const r = spawnSync(process.execPath, [SCRIPT, jsonPath], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.ok(!existsSync(join(dir, 'case.md')));
  });
});
