// Unit and integration tests for cases_overview rendering (HTML Dashboard & CLI table).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  escapeHtml,
  parseArgs,
  renderCliTable,
  renderDashboardHtml,
} from '../.claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs';

const SCRIPT = fileURLToPath(
  new URL('../.claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs', import.meta.url)
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

  it('renders stats, header badges, search input, and filter tabs', () => {
    const data = createSampleOverviewData();
    const html = renderDashboardHtml(data);

    // Total cases and stats
    assert.ok(html.includes('08603854'));
    assert.ok(html.includes('08642051'));
    assert.ok(html.includes('Total: 2'));

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

  it('renders direct portal links on case number and case title when url is available', () => {
    const data = createSampleOverviewData();
    const html = renderDashboardHtml(data);

    // Case 1 URL link on number and title
    assert.ok(html.includes('href="https://support.qualcomm.com/s/case/500dK00000Njp7aQAB/test-case"'));
    assert.ok(html.includes('target="_blank"'));
    assert.ok(html.includes('rel="noopener noreferrer"'));
  });

  it('renders Hidden Cases tab in filter navigation bar', () => {
    const data = createSampleOverviewData();
    const html = renderDashboardHtml(data);

    assert.ok(html.includes('data-filter="hidden"'));
    assert.ok(html.includes('Hidden Cases'));
  });

  it('renders expandable comment accordion with latest updates', () => {
    const data = createSampleOverviewData();
    const html = renderDashboardHtml(data);

    assert.ok(html.includes('Luyen Kieu Ba'));
    assert.ok(html.includes('MPSS. DE. Fix delivered to customer repo.'));
    assert.ok(html.includes('Sang Bui'));
    assert.ok(html.includes('Alex Chen'));
    assert.ok(html.includes('comments-accordion'));
  });

  it('renders AI summary when available', () => {
    const data = createSampleOverviewData();
    const html = renderDashboardHtml(data);

    assert.ok(html.includes('CR3798678 fix delivered'));
    assert.ok(html.includes('ai-summary'));
  });

  it('renders auto-refresh timer controls, interval selector, and manual refresh button', () => {
    const data = createSampleOverviewData();
    const html = renderDashboardHtml(data);

    // Auto-refresh interval dropdown & options
    assert.ok(html.includes('id="refreshInterval"'), 'Must render refreshInterval select element');
    assert.ok(html.includes('value="0">Off<'), 'Must have Off option');
    assert.ok(html.includes('value="60">1m<'), 'Must have 1m option');
    assert.ok(html.includes('value="120">2m<'), 'Must have 2m option');
    assert.ok(html.includes('value="300" selected>5m (default)<'), 'Must have 5m (default) option');
    assert.ok(html.includes('value="600">10m<'), 'Must have 10m option');
    assert.ok(html.includes('value="900">15m<'), 'Must have 15m option');

    // Live countdown ticker & refresh now button
    assert.ok(html.includes('id="countdownTicker"'), 'Must render countdownTicker');
    assert.ok(html.includes('Auto-refresh in: 05:00'), 'Must initialize default countdown ticker text');
    assert.ok(html.includes('id="refreshNowBtn"'), 'Must render refreshNowBtn');
    assert.ok(html.includes('🔄 Refresh Now'), 'Must include Refresh Now button text');

    // LocalStorage persistence logic for active filter, search query, and refresh interval
    assert.ok(html.includes('qc_dashboard_active_filter'), 'Must include active filter storage key');
    assert.ok(html.includes('qc_dashboard_search_query'), 'Must include search query storage key');
    assert.ok(html.includes('qc_dashboard_refresh_interval'), 'Must include refresh interval storage key');
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
