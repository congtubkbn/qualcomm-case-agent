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
import { walkCommentTree } from '../.claude/skills/qcomm/scripts/render_case.mjs';

const SCRIPT = fileURLToPath(new URL('../.claude/skills/qcomm/scripts/render_case.mjs', import.meta.url));

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
      accountName: 'OEM-Alpha',
      url: 'https://support.qualcomm.com/case/08460319',
      openedAt: '2026-08-18T08:00:00.000Z',
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
    assert.match(md, /\| Account Name \| OEM-Alpha \|/);
    assert.match(md, /\| Date Opened \| 2026-08-18T08:00:00\.000Z \|/);
    assert.match(md, /\| Updated \| 2026-08-20T14:30:00\.000Z \|/);
    assert.match(md, /\| Comments \| 2 \|/);
    assert.match(md, /\| Synced \| 2026-08-22T00:00:00\.000Z \|/);
    assert.match(md, /- \*\*Portal:\*\* \[Open in Qualcomm Profile \(qc:\/\/\)\]\(qc:\/\/case\/08460319\)/);

    // 2. Description section is rendered before timeline
    assert.match(md, /## Description\r?\n\r?\nUE fails registration on n78 standalone cell during initial attach\./);

    // 3. Chronological timeline of comments: synthesized description comment is suppressed,
    // subsequent comments start at #1, each with author + role label and NO summary line
    assert.match(md, /## Comments \(Oldest First\)/);
    assert.match(md, /### 1\. 2026-08-18T08:30:00\.000Z · Alice \(Customer\)/);
    assert.match(md, /Initial case filing with issue description\./);
    assert.match(md, /\*\*Attachments:\*\*\r?\n- \[modem_boot\.pcap\]\(https:\/\/support\.qualcomm\.com\/f\/pcap123\)/);

    assert.match(md, /### 2\. 2026-08-19T10:15:00\.000Z · Qualcomm Support \(Qualcomm\)/);
    assert.doesNotMatch(md, /> \*\*Summary:\*\*/, 'Summary preview lines must not be rendered');
    assert.match(md, /Please provide QXDM log with 0xB0C0 message mask\./);
    assert.match(md, /\*\*Attachments:\*\*\r?\n- \[mask_config\.cfg\]\(https:\/\/support\.qualcomm\.com\/f\/cfg123\)\r?\n- \[readme\.txt\]\(https:\/\/support\.qualcomm\.com\/f\/txt123\)/);
  });

  it('renders Salesforce Detail tab metadata (Contact Name, Customer Project, Customer Tracking, Account Name, Date Opened, Date Closed, Related CRs, Case Record Type)', () => {
    const detailCase = {
      caseNumber: '08550063',
      title: '5G NR throughput drop on SA network',
      status: 'Open',
      priority: 'P2',
      product: 'SM7635',
      contactName: 'Mai Ngoc',
      customerProject: 'Titan-5G',
      customerTracking: 'CT-999',
      accountName: 'OEM-Alpha',
      caseRecordType: 'External Case',
      relatedCRs: 'CR3798678, CR3801234',
      openedAt: '2026-08-18 10:00',
      closedAt: '2026-08-20 15:30',
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
    assert.match(md, /\| Customer Tracking \| CT-999 \|/);
    assert.match(md, /\| Account Name \| OEM-Alpha \|/);
    assert.match(md, /\| Date Opened \| 2026-08-18 10:00 \|/);
    assert.match(md, /\| Date Closed \| 2026-08-20 15:30 \|/);
    assert.match(md, /\| Case Record Type \| External Case \|/);
    assert.match(md, /\| Related CRs \| CR3798678, CR3801234 \|/);
  });

  it('renders threaded replies with hierarchical numbering (1, 1.1, 1.2)', () => {
    const threadedCase = {
      caseNumber: '08633581',
      title: 'Modem crash during handover',
      status: 'Open',
      comments: [
        {
          id: 'c1',
          author: 'Alice',
          timestamp: '2026-08-18T08:00:00.000Z',
          body: 'Top-level post describing the handover crash.',
          subs: [
            {
              id: 'c2',
              author: 'Bob (Qualcomm)',
              timestamp: '2026-08-18T09:00:00.000Z',
              body: 'First reply asking for logs.\nLine two of reply.',
              subs: [],
            },
            {
              id: 'c3',
              author: 'Alice',
              timestamp: '2026-08-18T10:00:00.000Z',
              body: 'Second reply with logs attached.',
              subs: [],
            },
          ],
        },
      ],
    };

    const r = renderFixture(threadedCase);
    assert.equal(r.exit, 0);
    const md = r.md();

    assert.match(md, /## Comments \(Oldest First\)/);
    assert.match(md, /### 1\. 2026-08-18T08:00:00\.000Z · Alice/);
    assert.match(md, /Top-level post describing the handover crash\./);

    assert.match(md, /### 1\.1\. ↳ 2026-08-18T09:00:00\.000Z · Bob \(Qualcomm\)/);
    assert.match(md, /> First reply asking for logs\.\s*\r?\n> Line two of reply\./);

    assert.match(md, /### 1\.2\. ↳ 2026-08-18T10:00:00\.000Z · Alice/);
    assert.match(md, /> Second reply with logs attached\./);
  });

  it('renders multiple top-level comment threads in oldest-first order with hierarchical numbers', () => {
    const multiThreadCase = {
      caseNumber: '08771122',
      title: 'Multi-thread nested comments test',
      status: 'Open',
      comments: [
        {
          id: 'c1',
          author: 'Alice',
          timestamp: '2026-08-18T08:00:00.000Z',
          body: 'First thread initial post.',
          subs: [
            {
              id: 'c1_1',
              author: 'Bob (Qualcomm)',
              timestamp: '2026-08-18T08:30:00.000Z',
              body: 'First reply to thread 1.',
              subs: [],
            },
            {
              id: 'c1_2',
              author: 'Alice',
              timestamp: '2026-08-18T09:00:00.000Z',
              body: 'Second reply to thread 1.',
              subs: [],
            },
          ],
        },
        {
          id: 'c2',
          author: 'Charlie',
          timestamp: '2026-08-18T10:00:00.000Z',
          body: 'Second thread without replies.',
          subs: [],
        },
        {
          id: 'c3',
          author: 'Dave',
          timestamp: '2026-08-18T11:00:00.000Z',
          body: 'Third thread initial post.',
          subs: [
            {
              id: 'c3_1',
              author: 'Qualcomm Support',
              timestamp: '2026-08-18T11:30:00.000Z',
              body: 'Reply to thread 3.',
              subs: [],
            },
          ],
        },
      ],
    };

    const r = renderFixture(multiThreadCase);
    assert.equal(r.exit, 0);
    const md = r.md();

    assert.match(md, /\| Comments \| 6 \|/);
    assert.match(md, /## Comments \(Oldest First\)/);

    // Assert chronological sequence of headings
    const h1 = md.indexOf('### 1. 2026-08-18T08:00:00.000Z · Alice');
    const h1_1 = md.indexOf('### 1.1. ↳ 2026-08-18T08:30:00.000Z · Bob');
    const h1_2 = md.indexOf('### 1.2. ↳ 2026-08-18T09:00:00.000Z · Alice');
    const h2 = md.indexOf('### 2. 2026-08-18T10:00:00.000Z · Charlie');
    const h3 = md.indexOf('### 3. 2026-08-18T11:00:00.000Z · Dave');
    const h3_1 = md.indexOf('### 3.1. ↳ 2026-08-18T11:30:00.000Z · Qualcomm Support');

    assert.ok(h1 !== -1 && h1_1 > h1, '1.1 must follow 1');
    assert.ok(h1_2 > h1_1, '1.2 must follow 1.1');
    assert.ok(h2 > h1_2, '2 must follow 1.2');
    assert.ok(h3 > h2, '3 must follow 2');
    assert.ok(h3_1 > h3, '3.1 must follow 3');
  });

  it('renders legacy flat comments with parentId into hierarchical structure via fallback', () => {
    const legacyCase = {
      caseNumber: '08633581',
      title: 'Legacy flat parentId structure',
      status: 'Open',
      comments: [
        {
          id: 'c1',
          author: 'Alice',
          timestamp: '2026-08-18T08:00:00.000Z',
          body: 'Top-level post.',
          parentId: null,
        },
        {
          id: 'c2',
          author: 'Bob (Qualcomm)',
          timestamp: '2026-08-18T09:00:00.000Z',
          body: 'Reply to post.',
          parentId: 'c1',
        },
      ],
    };

    const r = renderFixture(legacyCase);
    assert.equal(r.exit, 0);
    const md = r.md();

    assert.match(md, /### 1\. 2026-08-18T08:00:00\.000Z · Alice/);
    assert.match(md, /### 1\.1\. ↳ 2026-08-18T09:00:00\.000Z · Bob/);
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
    assert.match(r.md(), /\*\*Attachments:\*\*\r?\n- \[crash\.bin\]\(https:\/\/support\.qualcomm\.com\/download\/crash\.bin\)/);
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
    assert.match(r.md(), /Comments \(Oldest First\)/);
  });

  it('tolerates an empty comments array', () => {
    const r = renderFixture({ ...MINIMAL, comments: [] });
    assert.equal(r.exit, 0);
    assert.match(r.md(), /Comments \(Oldest First\)/);
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

describe('render_case: issue #93 body line structure and block formatting', () => {
  it('preserves newline-separated lines in comment bodies so line structure survives in rendered markdown', () => {
    const caseData = {
      ...MINIMAL,
      comments: [
        comment('Alice', 'Dear Customer,\nI shall check this from NAS POV and get back to you.\nThanks,\nAlice'),
      ],
    };
    const r = renderFixture(caseData);
    assert.equal(r.exit, 0);
    const md = r.md();
    // Line breaks should be preserved either with trailing spaces or explicit structure
    assert.match(md, /Dear Customer,  \r?\nI shall check this from NAS POV and get back to you\.  \r?\nThanks,  \r?\nAlice/);
  });

  it('renders a body of numbered steps as a list separated from preceding text', () => {
    const caseData = {
      ...MINIMAL,
      comments: [
        comment('Duc Hoang', 'Steps:\n1. Power on NR HPLMN SA Cell.\n2. UE Sends Registration request.\n3. Initiate ecall.'),
      ],
    };
    const r = renderFixture(caseData);
    assert.equal(r.exit, 0);
    const md = r.md();
    assert.match(md, /Steps:\r?\n\r?\n1\. Power on NR HPLMN SA Cell\.\r?\n2\. UE Sends Registration request\.\r?\n3\. Initiate ecall\./);
  });

  it('renders bodies with pipes, hashes, underscores, and asterisks without corrupting structure', () => {
    const caseData = {
      ...MINIMAL,
      comments: [
        comment('Tester', '# FAILlog_X716B_SEAU_5G.zip\n04:39:48.820 | 1 | NR5G NAS SERVICE REQUEST | ident_type: 4 (5G_S_TMSI)\nVariable SS_SM8550_Tab_S9 *bold* _italic_'),
      ],
    };
    const r = renderFixture(caseData);
    assert.equal(r.exit, 0);
    const md = r.md();
    // Leading '#' in a comment should be escaped so it doesn't create an H1 header
    assert.match(md, /\\# FAILlog_X716B_SEAU_5G\.zip/);
    assert.match(md, /04:39:48\.820 \| 1 \| NR5G NAS SERVICE REQUEST \| ident_type: 4 \(5G_S_TMSI\)/);
    assert.match(md, /Variable SS_SM8550_Tab_S9 \*bold\* _italic_/);
  });

  it('handles degenerate cases with missing description, empty comments without throwing', () => {
    const caseData = {
      caseNumber: '00000000',
      title: 'Empty case',
      description: '',
      comments: [],
    };
    const r = renderFixture(caseData);
    assert.equal(r.exit, 0);
    assert.ok(r.hasFile('case.md'));
    assert.ok(!r.hasFile('case.html'));
  });
});

describe('render_case: issue #94 render pasted log excerpts as fenced blocks', () => {
  it('renders reference log excerpt from case 08642051 as fenced code block with surrounding prose outside', () => {
    const logBody = [
      'Dear QC RRC team,',
      'Could you help check why modem does not trigger UlInformationTransfer to send SERVICE REQUEST?',
      '# FAILlog_X716B_SEAU_5G_IMS_Ecall_VoNR_redial_TC1_RTD.zip',
      '// SERVICE REQUEST with type "emergency serv fallback"',
      '04:39:48.820000 | 1 | NR5G NAS SERVICE REQUEST                       | service_type_val :4 (emergency serv fallback), ident_type :4 (5G_S_TMSI), pdu_session_status:PSI[1],PSI[2]',
      '// Since there is no ULInformationTransfer message, the equipment does not receive a SERVICE REQUEST.',
      '// Because there are no other frequencies available inside the shield box, the E911 call will fail.',
      '# PASSlog_X716B_oneui8.5_TC1_VoNR_PASS.zip',
      '01:26:27.935052 | 1 | NR5G NAS SERVICE REQUEST                       | service_type_val :4 (emergency serv fallback)',
    ].join('\n');

    const caseData = {
      ...MINIMAL,
      comments: [comment('Duc Hoang', logBody)],
    };
    const r = renderFixture(caseData);
    assert.equal(r.exit, 0);
    const md = r.md();

    // Surrounding prose stays outside the fence
    assert.match(md, /Dear QC RRC team,/);
    assert.match(md, /\/\/ SERVICE REQUEST with type "emergency serv fallback"/);
    assert.match(md, /\/\/ Since there is no ULInformationTransfer message/);

    // Reference log lines are fenced
    assert.match(md, /```\r?\n04:39:48\.820000 \| 1 \| NR5G NAS SERVICE REQUEST {23}\| service_type_val :4 \(emergency serv fallback\), ident_type :4 \(5G_S_TMSI\), pdu_session_status:PSI\[1\],PSI\[2\]\r?\n```/);
    assert.match(md, /```\r?\n01:26:27\.935052 \| 1 \| NR5G NAS SERVICE REQUEST {23}\| service_type_val :4 \(emergency serv fallback\)\r?\n```/);
  });

  it('groups multiple consecutive log lines into a single fenced code block without reflowing or wrapping', () => {
    const logBody = [
      'Captured log trace:',
      '01:26:27.935052 | 1 | NR5G NAS SERVICE REQUEST                       | service_type_val :4 (emergency serv fallback)',
      '01:26:27.935460 | 1 | NR5G RRC  UL_DCCH / UlInformationTransfer               | Cell ID:0, Freq:620352',
      '01:26:28.166996 | 1 | NR5G RRC  DL_DCCH / RRC Release                    | Cell ID:0, Freq:620352, eutraFrequency 1275',
      'End of trace.',
    ].join('\n');

    const caseData = {
      ...MINIMAL,
      comments: [comment('Engineer', logBody)],
    };
    const r = renderFixture(caseData);
    assert.equal(r.exit, 0);
    const md = r.md();

    const expectedBlock = [
      '```',
      '01:26:27.935052 | 1 | NR5G NAS SERVICE REQUEST                       | service_type_val :4 (emergency serv fallback)',
      '01:26:27.935460 | 1 | NR5G RRC  UL_DCCH / UlInformationTransfer               | Cell ID:0, Freq:620352',
      '01:26:28.166996 | 1 | NR5G RRC  DL_DCCH / RRC Release                    | Cell ID:0, Freq:620352, eutraFrequency 1275',
      '```',
    ].join('\n');

    assert.ok(
      md.replace(/\r\n/g, '\n').includes(expectedBlock),
      'Consecutive log lines must be rendered as a single fenced block verbatim'
    );
    assert.match(md, /Captured log trace:/);
    assert.match(md, /End of trace\./);
  });

  it('exempts fenced log lines from markdown character escaping', () => {
    const logBody = [
      '14:02:00.123 | 0 | PROTOCOL_MSG #1 *critical* _flag_ | payload: <data> & [value] | mask: 0xFF',
    ].join('\n');

    const caseData = {
      ...MINIMAL,
      comments: [comment('Tester', logBody)],
    };
    const r = renderFixture(caseData);
    assert.equal(r.exit, 0);
    const md = r.md();

    // Characters inside the fence must NOT be escaped with backslashes
    assert.ok(md.includes('14:02:00.123 | 0 | PROTOCOL_MSG #1 *critical* _flag_ | payload: <data> & [value] | mask: 0xFF'));
    assert.ok(!md.includes('\\#1'));
    assert.ok(!md.includes('\\*critical\\*'));
    assert.ok(!md.includes('\\_flag\\_'));
  });

  it('does not fence ordinary prose containing stray periods, colons or pipes', () => {
    const proseBodies = [
      'At 14:02:00, we verified that pipe | column formatting is maintained.',
      '2026-08-20 14:02:00 | System status report | All checks passed.',
      'Check time 04:39:48.820 - error occurred during startup.',
      'Ratio is 12:30:00 | score is high.',
      'Table header: Col 1 | Col 2 | Col 3',
      '1. Step one at 04:39:48 | check log',
    ];

    for (const body of proseBodies) {
      const caseData = {
        ...MINIMAL,
        comments: [comment('Author', body)],
      };
      const r = renderFixture(caseData);
      assert.equal(r.exit, 0);
      const md = r.md();
    assert.ok(!md.includes('```'), `Prose should not produce a fenced block: "${body}"`);
    }
  });
});

describe('render_case: issue #95 portal structure, Description section, role labels, no summary lines', () => {
  it('renders Description section before timeline and suppresses synthesized description comment from timeline', () => {
    const descText = 'Configuration:\n1. Enable Sib1 with ims-EmergencySupport-r9: true\n2. Power on NR cell.';
    const caseData = {
      caseNumber: '08642051',
      title: 'SIDIA Ecall Test VoNR redial',
      description: descText,
      comments: [
        {
          id: 'c_desc',
          author: 'Duc Hoang',
          role: 'Customer',
          timestamp: '8/10/2026, 7:37 PM',
          summary: 'Configuration: 1. Enable Sib1 with ims-EmergencySupport-r9: true',
          body: descText,
        },
        {
          id: 'c_qcom',
          author: 'Sushmita Suresh Rao',
          role: 'Qualcomm',
          timestamp: 'August 11, 2026 at 9:44 AM',
          summary: 'I shall check this from NAS POV and get back to you.',
          body: 'Dear Customer,\nI shall check this from NAS POV and get back to you.\nThanks,\nSushmita',
        },
      ],
    };

    const r = renderFixture(caseData);
    assert.equal(r.exit, 0);
    const md = r.md();

    // 1. Description section rendered before timeline
    const descIndex = md.indexOf('## Description');
    const timelineIndex = md.indexOf('## Comments (Oldest First)');
    assert.ok(descIndex > 0, 'Must have ## Description section');
    assert.ok(timelineIndex > descIndex, 'Timeline must appear after Description section');

    // 2. Description text appears exactly once in the entire document
    const occurrences = md.split('1. Enable Sib1 with ims-EmergencySupport-r9: true').length - 1;
    assert.equal(occurrences, 1, 'Description content must appear exactly once');

    // 3. Synthesized description comment does not appear as comment 1 in timeline
    assert.doesNotMatch(md, /### 1\. .* · Duc Hoang/);
    assert.match(md, /### 1\. August 11, 2026 at 9:44 AM · Sushmita Suresh Rao \(Qualcomm\)/);

    // 4. No summary line rendered
    assert.doesNotMatch(md, /> \*\*Summary:\*\*/);
  });

  it('renders author and Qualcomm/Customer role label for each comment', () => {
    const caseData = {
      caseNumber: '08112233',
      title: 'Call Drop Test',
      comments: [
        {
          author: 'Alice',
          timestamp: '2026-08-01T10:00:00.000Z',
          body: 'Call drops on cell boundary.',
        },
        {
          author: 'Qualcomm Support',
          timestamp: '2026-08-01T11:00:00.000Z',
          body: 'Dear customer,\nPlease provide QXDM log.',
        },
        {
          author: 'Automated Process',
          timestamp: '2026-08-01T12:00:00.000Z',
          body: 'Case status updated.',
        },
      ],
    };

    const r = renderFixture(caseData);
    assert.equal(r.exit, 0);
    const md = r.md();

    assert.match(md, /### 1\. 2026-08-01T10:00:00\.000Z · Alice \(Customer\)/);
    assert.match(md, /### 2\. 2026-08-01T11:00:00\.000Z · Qualcomm Support \(Qualcomm\)/);
    assert.match(md, /### 3\. 2026-08-01T12:00:00\.000Z · Automated Process \(System\)/);
  });

  it('omits Description section when case description is empty or whitespace-only', () => {
    const caseData = {
      caseNumber: '08999999',
      title: 'No Description Case',
      description: '   \n  ',
      comments: [
        {
          author: 'Bob',
          timestamp: '2026-08-01T10:00:00.000Z',
          body: 'Only feed comment.',
        },
      ],
    };

    const r = renderFixture(caseData);
    assert.equal(r.exit, 0);
    const md = r.md();

    assert.doesNotMatch(md, /^## Description$/m);
    assert.match(md, /### 1\. 2026-08-01T10:00:00\.000Z · Bob \(Customer\)/);
  });

  describe('Comment Attachments Rendering (Issue #96)', () => {
    it('renders comment attachments as a clean markdown list under the comment', () => {
      const caseData = {
        caseNumber: '08642051',
        title: 'VoNR Redial Ecall Test',
        comments: [
          {
            author: 'Duc Hoang',
            timestamp: '2026-08-10T19:59:00.000Z',
            body: 'Log files attached for analysis.',
            attachments: [
              {
                name: 'FAILlog_X716B_SEAU_5G_IMS_Ecall_VoNR_redial_TC1_RTD.zip',
                url: 'https://support.qualcomm.com/s/sfc/servlet.shepherd/version/download/068dK0000012345?asPdf=false&operationContext=CHATTER',
              },
              {
                name: 'QXDM_mask.cfg',
                url: 'https://support.qualcomm.com/s/sfc/servlet.shepherd/version/download/068dK0000067890',
              },
            ],
          },
        ],
      };

      const r = renderFixture(caseData);
      assert.equal(r.exit, 0);
      const md = r.md();

      assert.match(md, /\*\*Attachments:\*\*\r?\n- \[FAILlog_X716B_SEAU_5G_IMS_Ecall_VoNR_redial_TC1_RTD\.zip\]\(https:\/\/support\.qualcomm\.com\/s\/sfc\/servlet\.shepherd\/version\/download\/068dK0000012345\?asPdf=false&operationContext=CHATTER\)\r?\n- \[QXDM_mask\.cfg\]\(https:\/\/support\.qualcomm\.com\/s\/sfc\/servlet\.shepherd\/version\/download\/068dK0000067890\)/);
    });

    it('produces no attachment markup when comment has no attachments or empty attachments list', () => {
      const caseData = {
        caseNumber: '08642051',
        title: 'Empty Attachments Test',
        comments: [
          {
            author: 'Duc Hoang',
            timestamp: '2026-08-10T19:59:00.000Z',
            body: 'No attachments on this comment.',
            attachments: [],
          },
          {
            author: 'Qualcomm Engineer',
            timestamp: '2026-08-11T10:00:00.000Z',
            body: 'Also no attachments here.',
          },
        ],
      };

      const r = renderFixture(caseData);
      assert.equal(r.exit, 0);
      const md = r.md();

      assert.doesNotMatch(md, /\*\*Attachments:\*\*/);
    });

    it('gracefully degrades when attachment entries are malformed (missing URL, missing name, or plain string)', () => {
      const caseData = {
        caseNumber: '08642051',
        title: 'Malformed Attachments Test',
        comments: [
          {
            author: 'Duc Hoang',
            timestamp: '2026-08-10T19:59:00.000Z',
            body: 'Check various attachments.',
            attachments: [
              'standalone_filename.log',
              { name: 'file_with_no_url.zip' },
              { url: 'https://support.qualcomm.com/s/download/068999' },
              null,
              {},
            ],
          },
        ],
      };

      const r = renderFixture(caseData);
      assert.equal(r.exit, 0);
      const md = r.md();

      assert.match(md, /\*\*Attachments:\*\*\r?\n- standalone_filename\.log\r?\n- file_with_no_url\.zip\r?\n- \[https:\/\/support\.qualcomm\.com\/s\/download\/068999\]\(https:\/\/support\.qualcomm\.com\/s\/download\/068999\)/);
    });
  });
});

describe('render_case: issue #122 portal line — no Web Link', () => {
  it('renders only qc:// link when url is explicitly provided in case.json', () => {
    const caseData = {
      caseNumber: '08603854',
      title: 'Modem Crash on Handover',
      url: 'https://support.qualcomm.com/s/case/500dK00000OU6BqQAL/p26080302707',
      comments: [comment('Tester', 'Initial report')],
    };

    const r = renderFixture(caseData);
    assert.equal(r.exit, 0);
    const md = r.md();

    assert.match(
      md,
      /- \*\*Portal:\*\* \[Open in Qualcomm Profile \(qc:\/\/\)\]\(qc:\/\/case\/08603854\)/
    );
    assert.doesNotMatch(md, /Web Link/);
  });

  it('renders only qc:// link when url is absent in case.json (no fallback web link)', () => {
    const caseData = {
      caseNumber: '08550063',
      title: '5G NR throughput drop on SA network',
      comments: [comment('Mai Ngoc', 'Initial issue description with logs.')],
    };

    const r = renderFixture(caseData);
    assert.equal(r.exit, 0);
    const md = r.md();

    assert.match(
      md,
      /- \*\*Portal:\*\* \[Open in Qualcomm Profile \(qc:\/\/\)\]\(qc:\/\/case\/08550063\)/
    );
    assert.doesNotMatch(md, /Web Link/);
  });

  it('omits Portal line entirely when caseNumber is missing', () => {
    const caseData = {
      title: 'Case without number',
      url: 'https://support.qualcomm.com/s/case/500dK00000OU6BqQAL',
      comments: [comment('Alice', 'Test note')],
    };

    const r = renderFixture(caseData);
    assert.equal(r.exit, 0);
    const md = r.md();

    assert.doesNotMatch(md, /\*\*Portal:\*\*/);
    assert.doesNotMatch(md, /Web Link/);
  });
});

describe('walkCommentTree helper', () => {
  it('returns empty array when comments is not an array or is empty', () => {
    assert.deepEqual(walkCommentTree(null), []);
    assert.deepEqual(walkCommentTree(undefined), []);
    assert.deepEqual(walkCommentTree([]), []);
  });

  it('assigns hierarchical numbers and metadata to nested comment trees', () => {
    const tree = [
      {
        id: 'c1',
        author: 'A',
        subs: [
          { id: 'c1_1', author: 'B', subs: [] },
          { id: 'c1_2', author: 'C', subs: [] },
        ],
      },
      {
        id: 'c2',
        author: 'D',
        subs: [{ id: 'c2_1', author: 'E', subs: [] }],
      },
      {
        id: 'c3',
        author: 'F',
        subs: [],
      },
    ];

    const walked = walkCommentTree(tree);
    assert.equal(walked.length, 6);

    assert.equal(walked[0].number, '1');
    assert.equal(walked[0].depth, 0);
    assert.equal(walked[0].isReply, false);
    assert.equal(walked[0].parent, null);
    assert.equal(walked[0].comment.id, 'c1');

    assert.equal(walked[1].number, '1.1');
    assert.equal(walked[1].depth, 1);
    assert.equal(walked[1].isReply, true);
    assert.equal(walked[1].parent, tree[0]);
    assert.equal(walked[1].comment.id, 'c1_1');

    assert.equal(walked[2].number, '1.2');
    assert.equal(walked[2].depth, 1);
    assert.equal(walked[2].isReply, true);
    assert.equal(walked[2].parent, tree[0]);
    assert.equal(walked[2].comment.id, 'c1_2');

    assert.equal(walked[3].number, '2');
    assert.equal(walked[3].depth, 0);
    assert.equal(walked[3].isReply, false);
    assert.equal(walked[3].parent, null);
    assert.equal(walked[3].comment.id, 'c2');

    assert.equal(walked[4].number, '2.1');
    assert.equal(walked[4].depth, 1);
    assert.equal(walked[4].isReply, true);
    assert.equal(walked[4].parent, tree[1]);
    assert.equal(walked[4].comment.id, 'c2_1');

    assert.equal(walked[5].number, '3');
    assert.equal(walked[5].depth, 0);
    assert.equal(walked[5].isReply, false);
    assert.equal(walked[5].parent, null);
    assert.equal(walked[5].comment.id, 'c3');
  });

  it('invokes visitor callback for each node when provided', () => {
    const tree = [
      {
        id: 'c1',
        subs: [{ id: 'c1_1', subs: [] }],
      },
    ];
    const visited = [];
    walkCommentTree(tree, (c, item) => {
      visited.push(`${item.number}:${c.id}`);
    });
    assert.deepEqual(visited, ['1:c1', '1.1:c1_1']);
  });
});


