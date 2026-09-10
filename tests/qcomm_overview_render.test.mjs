// Unit and integration tests for cases_overview rendering (HTML Dashboard & CLI table).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../.claude/skills/qcomm/scripts/cases_overview.mjs';
import {
  escapeHtml,
  formatStaleness,
  getStatusCategory,
  renderCaseRow,
  renderCasesTable,
  renderClientScript,
  renderControlsBar,
  renderDashboardHtml,
  renderHeader,
  renderProtocolModal,
  renderStyles,
} from '../.claude/skills/qcomm/scripts/dashboard_renderer.mjs';
import { renderCliTable } from '../.claude/skills/qcomm/scripts/cli_renderer.mjs';

const SCRIPT = fileURLToPath(
  new URL('../.claude/skills/qcomm/scripts/cases_overview.mjs', import.meta.url)
);

function createSampleOverviewData() {
  return {
    cases: [
      {
        caseNumber: '08603854',
        title: '[DE.3.1.4][SM7635] epsfb_if_emc_and_no_vonr does not work & test <script>',
        status: 'Closed-Customer Requested',
        priority: '2 - High',
        product: 'SM7635',
        url: 'https://support.qualcomm.com/s/case/500dK00000Njp7aQAB/test-case',
        syncedAt: '2026-08-22T23:18:35.894Z',
        lastCommentAt: 'July 22, 2026 at 5:42 AM',
        lastCommentAuthor: 'Luyen Kieu Ba',
        commentCount: 4,
        hasSummary: true,
        aiSummary: 'Resolution: CR3798678 fix delivered | Root cause: nr5g voice flag',
        latestComments: [
          {
            id: 'c4',
            author: 'Luyen Kieu Ba',
            timestamp: 'July 22, 2026 at 5:42 AM',
            snippet: 'MPSS. DE. Fix delivered to customer repo.',
          },
          {
            id: 'c3',
            author: 'Sang Bui',
            timestamp: 'July 22, 2026 at 12:00 AM',
            snippet: 'Testing on live UE setup.',
          },
        ],
      },
      {
        caseNumber: '08642051',
        title: 'Modem RF crash during 5G SA registration',
        status: 'Open',
        priority: '1 - Critical',
        product: 'SDX75',
        url: 'https://support.qualcomm.com/s/case/500dK00000HZeVSQA1/rf-crash',
        syncedAt: '2026-08-21T10:00:00.000Z',
        lastCommentAt: 'Aug 21, 2026',
        lastCommentAuthor: 'Alex Chen',
        commentCount: 1,
        hasSummary: false,
        aiSummary: null,
        latestComments: [
          {
            id: 'c1',
            author: 'Alex Chen',
            timestamp: 'Aug 21, 2026',
            snippet: 'Initial filing with crashdump pcap attached.',
          },
        ],
      },
    ],
    stats: {
      total: 2,
      byStatus: {
        'Closed-Customer Requested': 1,
        'Open': 1,
      },
      lastUpdated: '2026-08-23T06:00:00.000Z',
    },
  };
}

describe('cases_overview_render: getStatusCategory (#201)', () => {
  it('distinguishes Pending Qualcomm vs Pending Customer into 2 separate categories via ballInCourt', () => {
    assert.equal(getStatusCategory('Pending Qualcomm', 'qualcomm'), 'pending_qualcomm');
    assert.equal(getStatusCategory('Pending Customer', 'customer'), 'pending_customer');
    assert.notEqual(
      getStatusCategory('Pending Qualcomm', 'qualcomm'),
      getStatusCategory('Pending Customer', 'customer')
    );
  });

  it('prioritizes ballInCourt over status text when present, regardless of the status string', () => {
    assert.equal(getStatusCategory('In Progress', 'qualcomm'), 'pending_qualcomm');
    assert.equal(getStatusCategory('In Progress', 'customer'), 'pending_customer');
  });

  it('falls back to prior status-text heuristics when ballInCourt is absent or unassigned (#193 bug: both collapsed into in_progress)', () => {
    assert.equal(getStatusCategory('Open'), 'open');
    assert.equal(getStatusCategory('Closed-Resolved'), 'closed');
    assert.equal(getStatusCategory('Action Required'), 'action_required');
    assert.equal(getStatusCategory('Pending Qualcomm'), 'in_progress');
    assert.equal(getStatusCategory('Pending Customer'), 'in_progress');
    assert.equal(getStatusCategory('In Progress', 'unassigned'), 'in_progress');
    assert.equal(getStatusCategory(null), 'other');
  });
});

describe('cases_overview_render: formatStaleness (#201)', () => {
  it('formats relative day counts and handles edge cases', () => {
    const now = new Date('2026-08-25T00:00:00.000Z');
    assert.equal(formatStaleness('2026-08-25T00:00:00.000Z', now), 'Today');
    assert.equal(formatStaleness('2026-08-24T00:00:00.000Z', now), '1 day ago');
    assert.equal(formatStaleness('2026-08-15T00:00:00.000Z', now), '10 days ago');
    assert.equal(formatStaleness('', now), '');
    assert.equal(formatStaleness(null, now), '');
    // Legacy non-ISO absolute text (pre-#199 normalization) is not Date-parseable.
    assert.equal(formatStaleness('July 22, 2026 at 5:42 AM', now), '');
  });
});

describe('cases_overview_render: escapeHtml helper', () => {
  it('escapes &, <, >, ", and \' characters properly', () => {
    assert.equal(escapeHtml('Hello <World> & "Friends" \'test\''), 'Hello &lt;World&gt; &amp; &quot;Friends&quot; &#039;test&#039;');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(123), '123');
  });
});

describe('cases_overview_render: renderDashboardHtml', () => {
  it('generates self-contained HTML with zero external CDN dependencies', () => {
    const data = createSampleOverviewData();
    const html = renderDashboardHtml(data);

    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('<html lang="en"'));
    assert.ok(html.includes('Qualcomm Cases Dashboard'));

    // Zero CDN rule: must not reference http(s) links in link tags or script tags
    assert.doesNotMatch(html, /<link[^>]+href=["']https?:\/\//i, 'Must not load external stylesheets via CDN');
    assert.doesNotMatch(html, /<script[^>]+src=["']https?:\/\//i, 'Must not load external scripts via CDN');
  });

  it('escapes dynamic user content to prevent XSS', () => {
    const data = createSampleOverviewData();
    const html = renderDashboardHtml(data);

    assert.ok(html.includes('&amp; test &lt;script&gt;'));
    assert.doesNotMatch(html, /<script>epsfb/);
  });

  it('renders header meta, search input, and filter tabs', () => {
    const data = createSampleOverviewData();
    const html = renderDashboardHtml(data);

    // Total cases and case rows
    assert.ok(html.includes('08603854'));
    assert.ok(html.includes('08642051'));
    assert.ok(html.includes('2 cases'));

    // Search bar
    assert.ok(html.includes('id="searchInput"'));

    // Filter tabs
    assert.ok(html.includes('data-filter="all"'));
    assert.ok(html.includes('data-filter="open"'));
    assert.ok(html.includes('data-filter="in_progress"'));
    assert.ok(html.includes('data-filter="closed"'));
    assert.ok(html.includes('data-filter="action_required"'));
  });

  it('renders copy button, hide button, and unhide button for case cards', () => {
    const data = createSampleOverviewData();
    const html = renderDashboardHtml(data);

    // 1-click Copy ID button
    assert.ok(html.includes('copy-btn'));
    assert.ok(html.includes('data-case-id="08603854"'));
    assert.ok(html.includes('data-case-id="08642051"'));

    // Hide & Unhide buttons
    assert.ok(html.includes('hide-btn'));
    assert.ok(html.includes('unhide-btn'));
  });

  it('renders qc:// protocol links on case number and case title', () => {
    const data = createSampleOverviewData();
    const html = renderDashboardHtml(data);

    // Case 1 qc:// link on number and title
    assert.ok(html.includes('href="qc://case/08603854"'));
    assert.ok(html.includes('title="Open in Qualcomm Profile (qc://)"'));
    assert.ok(html.includes('href="qc://case/08642051"'));
    assert.ok(html.includes('<a href="qc://case/08603854" class="case-number" title="Open in Qualcomm Profile (qc://)">#08603854</a>'));
    assert.ok(html.includes('<a href="qc://case/08603854" title="Open in Qualcomm Profile (qc://)">'));
  });

  it('does NOT render Web Link action button on any case card (issue #121)', () => {
    const data = createSampleOverviewData();
    const html = renderDashboardHtml(data);

    // Web Link button must be fully removed from card toolbar
    assert.doesNotMatch(html, /class="action-btn weblink-btn"/, 'Must not render weblink-btn');
    assert.doesNotMatch(html, /🔗 Web Link/, 'Must not render Web Link label');
    assert.doesNotMatch(html, /target="_blank" rel="noopener noreferrer" class="action-btn weblink-btn"/, 'Must not render Web Link anchor');
  });

  it('renders Protocol Help button in header and modal dialog with 1-click copy command', () => {
    const data = createSampleOverviewData();
    const html = renderDashboardHtml(data);

    // Header button (icon-only, title carries the label)
    assert.ok(html.includes('id="protocolHelpBtn"'));
    assert.ok(html.includes('title="Protocol Help"'));

    // Modal dialog and contents — command copy/paste only, no prose sections
    assert.ok(html.includes('id="protocolModal"'));
    assert.ok(html.includes('class="modal-overlay"'));
    assert.ok(html.includes('powershell -ExecutionPolicy Bypass -File scripts/register_protocol.ps1'));
    assert.ok(html.includes('id="copyProtocolCmdBtn"'));
    assert.ok(html.includes('id="closeModalBtn"'));
    assert.ok(html.includes('⚙️ Protocol Help'));
    assert.doesNotMatch(html, /qc:\/\/ Protocol/, 'Modal must not render the removed qc:// explanation section');
    assert.doesNotMatch(html, /How to Test/, 'Modal must not render the removed How to Test section');
    assert.doesNotMatch(html, /Dual-Mode Links Explained/, 'Modal must not reference Dual-Mode (Web Link fallback removed)');

    // Modal interactive scripts (Escape key handler and click-outside backdrop dismiss)
    assert.ok(html.includes('protocolModal.classList.remove(\'active\')'));
    assert.ok(html.includes('e.key === \'Escape\''));
  });

  it('renders a Delete button per case card that copies a safe chat instruction, never a raw CLI command', () => {
    const data = createSampleOverviewData();
    const html = renderDashboardHtml(data);

    // One Delete button per card, each carrying that card's own case code.
    assert.ok(html.includes('🗑️ Delete'));
    const deleteButtonCount = (html.match(/class="[^"]*delete-btn[^"]*"/g) || []).length;
    assert.equal(deleteButtonCount, data.cases.length);
    for (const c of data.cases) {
      assert.ok(
        html.includes(`class="action-btn delete-btn" data-case-id="${c.caseNumber}"`),
        `expected a delete-btn wired to case ${c.caseNumber}`,
      );
    }

    // Isolate the delete-btn click handler to check its body specifically —
    // global regexes over the whole document would pass even if this
    // handler leaked a CLI command, since other unrelated script/markup
    // could legitimately contain none of these patterns anyway.
    const handlerMatch = html.match(
      /document\.querySelectorAll\('\.delete-btn'\)[\s\S]*?\n {6}\}\);/,
    );
    assert.ok(handlerMatch, 'expected to find the delete-btn click handler block');
    const handlerBody = handlerMatch[0];

    // Copied text is a natural-language chat instruction containing the case
    // code — never a literal CLI invocation, and never a --yes flag (ADR
    // 0003: a copied --yes command could be pasted straight into a terminal,
    // skipping the agent-mediated confirmation this feature exists for).
    assert.ok(handlerBody.includes('xóa case ${caseId} khỏi cache local'));
    assert.doesNotMatch(handlerBody, /delete_case\.mjs/);
    assert.doesNotMatch(handlerBody, /--yes/);

    // No fetch/navigation/filesystem access from the click handler.
    assert.doesNotMatch(handlerBody, /fetch\(|window\.open|location\s*[.=]/);
  });

  it('renders Hidden Cases tab in filter navigation bar', () => {
    const data = createSampleOverviewData();
    const html = renderDashboardHtml(data);

    assert.ok(html.includes('data-filter="hidden"'));
    assert.ok(html.includes('Hidden Cases'));
  });

  it('renders latest comments inside the expandable detail row', () => {
    const data = createSampleOverviewData();
    const html = renderDashboardHtml(data);

    assert.ok(html.includes('Luyen Kieu Ba'));
    assert.ok(html.includes('MPSS. DE. Fix delivered to customer repo.'));
    assert.ok(html.includes('Sang Bui'));
    assert.ok(html.includes('Alex Chen'));
    assert.ok(html.includes('comments-list'));
    assert.ok(html.includes('class="detail-row"'));
  });

  it('renders AI summary when available', () => {
    const data = createSampleOverviewData();
    const html = renderDashboardHtml(data);

    assert.ok(html.includes('CR3798678 fix delivered'));
    assert.ok(html.includes('ai-summary'));
  });

  it('renders Two-Tier data grid layout with always-visible meta sublines', () => {
    const data = createSampleOverviewData();
    const html = renderDashboardHtml(data);

    assert.ok(html.includes('Timeline (Always)'), 'Must render Timeline (Always) header');
    assert.ok(html.includes('Status &amp; Priority') || html.includes('Status & Priority'), 'Must render Status & Priority header');
    assert.ok(html.includes('Activity (Always)'), 'Must render Activity (Always) header');
    assert.ok(html.includes('case-meta-subline'), 'Must render case-meta-subline');
    assert.ok(html.includes('time-col'), 'Must render time-col');
    assert.ok(html.includes('status-col'), 'Must render status-col');
    assert.ok(html.includes('activity-col'), 'Must render activity-col');
  });

  it('renders collapsible Recent Updates section with comments toggle button', () => {
    const data = createSampleOverviewData();
    const html = renderDashboardHtml(data);

    assert.ok(html.includes('comments-toggle-btn'), 'Must render comments-toggle-btn');
    assert.ok(html.includes('comments-collapse-wrap'), 'Must render comments-collapse-wrap');
    assert.ok(html.includes('comments-drawer'), 'Must render comments-drawer');
  });

  it('renders auto-refresh icon toolbar with interval popover and manual refresh button', () => {
    const data = createSampleOverviewData();
    const html = renderDashboardHtml(data);

    // Auto-refresh interval popover & options (icon-only trigger, no visible select/label)
    assert.ok(html.includes('id="intervalBtn"'), 'Must render intervalBtn');
    assert.ok(html.includes('id="intervalPopover"'), 'Must render intervalPopover');
    assert.ok(html.includes('data-val="0"') && html.includes('>Off<'), 'Must have Off option');
    assert.ok(html.includes('data-val="60"') && html.includes('>1m<'), 'Must have 1m option');
    assert.ok(html.includes('data-val="120"') && html.includes('>2m<'), 'Must have 2m option');
    assert.ok(html.includes('data-val="300"') && html.includes('>5m<'), 'Must have 5m (default) option');
    assert.ok(html.includes('data-val="600"') && html.includes('>10m<'), 'Must have 10m option');
    assert.ok(html.includes('data-val="900"') && html.includes('>15m<'), 'Must have 15m option');
    assert.doesNotMatch(html, /id="refreshInterval"/, 'Must not render the old <select> element');

    // Countdown surfaces only via the interval button's title tooltip, not visible header text
    assert.ok(html.includes("intervalBtn.title = refreshSeconds <= 0"), 'Must drive the tooltip from the countdown state');
    assert.ok(html.includes("'Auto-refresh in: ' + formatTime(remainingSeconds)"), 'Must format the remaining-time tooltip');
    assert.doesNotMatch(html, /id="countdownTicker"/, 'Must not render a separate visible countdown ticker element');

    assert.ok(html.includes('id="refreshNowBtn"'), 'Must render refreshNowBtn');
    assert.ok(html.includes('title="Refresh dashboard now"'), 'Must label refreshNowBtn via title, not visible text');

    // LocalStorage persistence logic for active filter, search query, and refresh interval
    assert.ok(html.includes('qc_dashboard_active_filter'), 'Must include active filter storage key');
    assert.ok(html.includes('qc_dashboard_search_query'), 'Must include search query storage key');
    assert.ok(html.includes('qc_dashboard_refresh_interval'), 'Must include refresh interval storage key');
  });

  it('renders distinct badge categories and filter tabs for Pending Qualcomm vs Pending Customer (#201)', () => {
    const data = {
      cases: [
        {
          caseNumber: '08111111',
          title: 'Case waiting on Qualcomm',
          status: 'Pending',
          ballInCourt: 'qualcomm',
          latestComments: [],
        },
        {
          caseNumber: '08222222',
          title: 'Case waiting on Customer',
          status: 'Pending',
          ballInCourt: 'customer',
          latestComments: [],
        },
      ],
      stats: { total: 2, byStatus: { Pending: 2 }, lastUpdated: '2026-08-23T06:00:00.000Z' },
    };
    const html = renderDashboardHtml(data);

    assert.ok(html.includes('data-status-category="pending_qualcomm"'));
    assert.ok(html.includes('data-status-category="pending_customer"'));
    assert.ok(html.includes('status-tag-pending_qualcomm'));
    assert.ok(html.includes('status-tag-pending_customer'));
    assert.ok(html.includes('data-filter="pending_qualcomm"'));
    assert.ok(html.includes('data-filter="pending_customer"'));
    assert.ok(html.includes('Pending Qualcomm (1)'));
    assert.ok(html.includes('Pending Customer (1)'));
  });

  it('renders a staleness label from lastCommentAt (#201)', () => {
    const data = {
      cases: [
        {
          caseNumber: '08333333',
          title: 'Stale case',
          status: 'Open',
          lastCommentAt: '2020-01-01T00:00:00.000Z',
          latestComments: [],
        },
      ],
      stats: { total: 1, byStatus: { Open: 1 }, lastUpdated: '2026-08-23T06:00:00.000Z' },
    };
    const html = renderDashboardHtml(data);

    assert.ok(html.includes('activity-staleness'));
    assert.match(html, /\d+ days ago/);
    assert.ok(html.includes('title="2020-01-01T00:00:00.000Z"'));
  });

  it('writes HTML to disk when outputPath is provided', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'qc-dash-test-'));
    const outputPath = join(tempDir, 'dashboard.html');
    const data = createSampleOverviewData();

    const html = renderDashboardHtml(data, outputPath);
    assert.ok(existsSync(outputPath));
    const diskContent = readFileSync(outputPath, 'utf8');
    assert.equal(diskContent, html);

    rmSync(tempDir, { recursive: true, force: true });
  });
});

describe('cases_overview_render: parseArgs auto-launch & CLI options', () => {
  it('defaults open to true, and disables open when --json or --no-open is passed', () => {
    const argsDefault = parseArgs([]);
    assert.equal(argsDefault.open, true);

    const argsJson = parseArgs(['--json']);
    assert.equal(argsJson.json, true);
    assert.equal(argsJson.open, false);

    const argsNoOpen = parseArgs(['--no-open']);
    assert.equal(argsNoOpen.open, false);
    assert.equal(argsNoOpen.noOpen, true);
  });

  it('respects explicit --open flag even when --json is passed if --open is specified', () => {
    const argsOpen = parseArgs(['--open']);
    assert.equal(argsOpen.open, true);

    const argsJsonOpen = parseArgs(['--json', '--open']);
    assert.equal(argsJsonOpen.open, true);
  });
});

describe('cases_overview_render: renderCliTable', () => {
  it('renders formatted terminal summary and case cards', () => {
    const data = createSampleOverviewData();
    const output = renderCliTable(data);

    assert.ok(output.includes('QUALCOMM CASES OVERVIEW (2 cases)'));
    assert.ok(output.includes('[08603854]'));
    assert.ok(output.includes('[08642051]'));
    assert.ok(output.includes('Closed-Customer Requested'));
    assert.ok(output.includes('SM7635'));
    assert.ok(output.includes('CR3798678 fix delivered'));
    assert.ok(output.includes('MPSS. DE. Fix delivered to customer repo.'));
  });

  it('supports filter option in CLI table rendering', () => {
    const data = createSampleOverviewData();
    const output = renderCliTable(data, { filter: 'open' });

    assert.ok(output.includes('[08642051]'));
    assert.ok(!output.includes('[08603854]'));
  });

  it('renders Raised by information when raisedBy is present in case record', () => {
    const data = {
      cases: [
        {
          caseNumber: '08111222',
          title: 'Emergency call drop',
          status: 'Open',
          raisedBy: 'John Creator',
          commentCount: 2,
        },
      ],
      stats: { total: 1, byStatus: { Open: 1 } },
    };
    const output = renderCliTable(data);
    assert.ok(output.includes('Raised by: John Creator'), 'Should contain Raised by: John Creator');
  });

  it('renders Pending On and staleness signal in CLI summary table (#201)', () => {
    const data = {
      cases: [
        {
          caseNumber: '08444444',
          title: 'Stale customer-pending case',
          status: 'Pending',
          ballInCourt: 'customer',
          lastCommentAt: '2020-01-01T00:00:00.000Z',
          commentCount: 1,
        },
      ],
      stats: { total: 1, byStatus: { Pending: 1 } },
    };
    const output = renderCliTable(data);
    assert.ok(output.includes('Pending On: customer'), 'Should contain Pending On: customer');
    assert.match(output, /Last activity: \d+ days ago \(2020-01-01T00:00:00\.000Z\)/);
  });

  it('renders Customer Project and opened timestamp in CLI summary table', () => {
    const data = {
      cases: [
        {
          caseNumber: '08550063',
          title: '5G SA Attach issue',
          status: 'Open',
          product: 'SM7635',
          customerProject: 'Titan-5G',
          raisedBy: 'Mai Ngoc',
          openedAt: '2026-08-18 10:00',
          commentCount: 3,
        },
      ],
      stats: { total: 1, byStatus: { Open: 1 } },
    };
    const output = renderCliTable(data);
    assert.ok(output.includes('Project: Titan-5G'), 'CLI output should include Project: Titan-5G');
    assert.ok(output.includes('Raised by: Mai Ngoc'), 'CLI output should include Raised by: Mai Ngoc');
    assert.ok(output.includes('Opened: 2026-08-18 10:00'), 'CLI output should include Opened: 2026-08-18 10:00');
  });
});

describe('cases_overview_render: dashboard HTML Detail fields rendering', () => {
  it('renders Customer Project badge, opened timestamp, and search tokens in dashboard HTML', () => {
    const data = {
      cases: [
        {
          caseNumber: '08550063',
          title: '5G SA Attach issue',
          status: 'Open',
          priority: '2 - High',
          product: 'SM7635',
          customerProject: 'Titan-5G',
          contactName: 'Mai Ngoc',
          raisedBy: 'Mai Ngoc',
          openedAt: '2026-08-18 10:00',
          syncedAt: '2026-08-22T23:18:35.894Z',
          commentCount: 3,
          latestComments: [],
        },
      ],
      stats: { total: 1, byStatus: { Open: 1 }, lastUpdated: '2026-08-23T06:00:00.000Z' },
    };
    const html = renderDashboardHtml(data);
    assert.ok(html.includes('badge-project'), 'Must render badge-project CSS class');
    assert.ok(html.includes('Titan-5G'), 'Must render Titan-5G project name');
    assert.ok(html.includes('Raised by: Mai Ngoc'), 'Must render Raised by: Mai Ngoc in meta-row');
    assert.ok(html.includes('Project: Titan-5G'), 'Must render Project: Titan-5G in meta-row');
    assert.ok(html.includes('Opened: 2026-08-18 10:00'), 'Must render Opened: 2026-08-18 10:00 in meta-row');
    assert.ok(html.includes('data-search="08550063 5G SA Attach issue SM7635 Titan-5G Mai Ngoc Mai Ngoc Open 2 - High 2026-08-18 10:00"'), 'Search index must include project, contact, and openedAt');
  });
});

describe('cases_overview_render: CLI integration for HTML & dashboard', () => {
  it('generates dashboard.html on --rebuild or --html', () => {
    const casesDir = mkdtempSync(join(tmpdir(), 'qc-cli-render-'));
    const case1Dir = join(casesDir, '08603854');
    mkdirSync(case1Dir, { recursive: true });
    writeFileSync(
      join(case1Dir, 'case.json'),
      JSON.stringify({
        caseNumber: '08603854',
        title: 'Case 1',
        status: 'Open',
        comments: [],
      }),
      'utf8'
    );

    const r = spawnSync(
      process.execPath,
      [SCRIPT, '--rebuild', `--cases-dir=${casesDir}`],
      { encoding: 'utf8' }
    );

    assert.equal(r.status, 0);
    assert.ok(existsSync(join(casesDir, 'dashboard.html')));
    assert.ok(existsSync(join(casesDir, '_overview.json')));

    rmSync(casesDir, { recursive: true, force: true });
  });
});

describe('cases_overview_render: composable template functions (#232)', () => {
  it('renderCaseRow renders case-row and detail-row for a single case in isolation', () => {
    const c = {
      caseNumber: '08999999',
      title: 'Isolated case title',
      status: 'Open',
      priority: '1 - Critical',
      product: 'SDX75',
      customerProject: 'Apollo',
      contactName: 'Jane Dev',
      raisedBy: 'Jane Dev',
      openedAt: '2026-09-01',
      syncedAt: '2026-09-02T00:00:00.000Z',
      commentCount: 1,
      hasSummary: true,
      aiSummary: 'Isolated executive test',
      latestComments: [
        { author: 'Jane Dev', timestamp: '2026-09-01', snippet: 'Isolated comment snippet' },
      ],
    };
    const rowHtml = renderCaseRow(c);
    assert.ok(rowHtml.includes('class="case-row"'));
    assert.ok(rowHtml.includes('class="detail-row"'));
    assert.ok(rowHtml.includes('data-case-id="08999999"'));
    assert.ok(rowHtml.includes('href="qc://case/08999999"'));
    assert.ok(rowHtml.includes('Isolated case title'));
    assert.ok(rowHtml.includes('pri-critical'));
    assert.ok(rowHtml.includes('badge-project'));
    assert.ok(rowHtml.includes('Apollo'));
    assert.ok(rowHtml.includes('Isolated executive test'));
    assert.ok(rowHtml.includes('Isolated comment snippet'));
    assert.ok(rowHtml.includes('class="action-btn delete-btn"'));
  });

  it('renderHeader renders total count, lastUpdated, and toolbar actions', () => {
    const stats = { total: 42, lastUpdated: '2026-09-11T12:00:00.000Z' };
    const headerHtml = renderHeader(stats);
    assert.ok(headerHtml.includes('<header>'));
    assert.ok(headerHtml.includes('42 cases'));
    assert.ok(headerHtml.includes('last updated: 2026-09-11T12:00:00.000Z'));
    assert.ok(headerHtml.includes('id="refreshNowBtn"'));
    assert.ok(headerHtml.includes('id="intervalBtn"'));
    assert.ok(headerHtml.includes('id="protocolHelpBtn"'));
    assert.ok(headerHtml.includes('id="themeToggle"'));
  });

  it('renderControlsBar renders search input and tab counts', () => {
    const stats = { total: 10 };
    const counts = {
      open: 3,
      in_progress: 2,
      pending_qualcomm: 1,
      pending_customer: 2,
      action_required: 1,
      closed: 1,
    };
    const controlsHtml = renderControlsBar(stats, counts);
    assert.ok(controlsHtml.includes('id="searchInput"'));
    assert.ok(controlsHtml.includes('All (10)'));
    assert.ok(controlsHtml.includes('Open (3)'));
    assert.ok(controlsHtml.includes('In Progress (2)'));
    assert.ok(controlsHtml.includes('Pending Qualcomm (1)'));
    assert.ok(controlsHtml.includes('Pending Customer (2)'));
    assert.ok(controlsHtml.includes('Action Required (1)'));
    assert.ok(controlsHtml.includes('Closed (1)'));
  });

  it('renderCasesTable wraps rows inside cases-table container and header', () => {
    const tableHtml = renderCasesTable('<tr><td>Mock Row</td></tr>');
    assert.ok(tableHtml.includes('class="table-wrap"'));
    assert.ok(tableHtml.includes('<table class="cases-table">'));
    assert.ok(tableHtml.includes('Case & Details'));
    assert.ok(tableHtml.includes('<tr><td>Mock Row</td></tr>'));
  });

  it('renderProtocolModal renders modal overlay and registration command', () => {
    const modalHtml = renderProtocolModal();
    assert.ok(modalHtml.includes('id="protocolModal"'));
    assert.ok(modalHtml.includes('powershell -ExecutionPolicy Bypass -File scripts/register_protocol.ps1'));
    assert.ok(modalHtml.includes('npm run setup:protocol'));
  });

  it('renderStyles returns complete CSS style tag with variables and dark mode', () => {
    const stylesHtml = renderStyles();
    assert.ok(stylesHtml.startsWith('  <style>'));
    assert.ok(stylesHtml.endsWith('  </style>'));
    assert.ok(stylesHtml.includes('--bg: #fafaf9;'));
    assert.ok(stylesHtml.includes('[data-theme="dark"]'));
  });

  it('renderClientScript returns complete script tag with event listeners', () => {
    const scriptHtml = renderClientScript();
    assert.ok(scriptHtml.startsWith('  <script>'));
    assert.ok(scriptHtml.endsWith('  </script>'));
    assert.ok(scriptHtml.includes('document.addEventListener(\'DOMContentLoaded\''));
    assert.ok(scriptHtml.includes('applyFilters'));
  });
});

