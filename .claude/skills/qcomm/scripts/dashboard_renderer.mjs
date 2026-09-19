// Assembles the self-contained, offline HTML dashboard for Qualcomm case overview data
// from its styles, client script, and row/page templating modules.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { renderStyles } from './dashboard_styles.mjs';
import { renderClientScript } from './dashboard_client_script.mjs';
import { renderCaseRow } from './dashboard_row.mjs';
import { escapeHtml } from './html_escape.mjs';
import { getStatusCategory } from './status_category.mjs';
import { formatStaleness } from './staleness.mjs';

export { escapeHtml, formatStaleness, getStatusCategory, renderCaseRow, renderClientScript, renderStyles };

/**
 * @param {object} stats Overview stats { total, lastUpdated }
 * @returns {string}
 */
export function renderHeader(stats) {
  return `    <header>
      <div>
        <h1 class="brand-title">Qualcomm Cases Dashboard</h1>
        <div class="meta">
          ${stats.total} cases — last updated: ${escapeHtml(stats.lastUpdated || '')}
        </div>
      </div>
      <div class="header-actions">
        <div class="toolbar-pill" id="toolbarPill">
          <button id="refreshNowBtn" class="icon-btn" type="button" title="Refresh dashboard now">🔄</button>
          <span class="pill-divider"></span>
          <div class="interval-wrap">
            <button id="intervalBtn" class="icon-btn" type="button" title="Auto-refresh: 5m" aria-haspopup="true" aria-expanded="false">⏱</button>
            <div id="intervalPopover" class="interval-popover" role="menu" aria-label="Auto-refresh interval">
              <button type="button" data-val="0" role="menuitemradio" aria-checked="false">Off</button>
              <button type="button" data-val="60" role="menuitemradio" aria-checked="false">1m</button>
              <button type="button" data-val="120" role="menuitemradio" aria-checked="false">2m</button>
              <button type="button" data-val="300" class="active" role="menuitemradio" aria-checked="true">5m</button>
              <button type="button" data-val="600" role="menuitemradio" aria-checked="false">10m</button>
              <button type="button" data-val="900" role="menuitemradio" aria-checked="false">15m</button>
            </div>
          </div>
          <span class="pill-divider"></span>
          <button id="protocolHelpBtn" class="icon-btn" type="button" title="Protocol Help">⚙️</button>
          <span class="pill-divider"></span>
          <button id="themeToggle" class="icon-btn" type="button" title="Toggle theme" aria-label="Toggle theme">🌙</button>
        </div>
      </div>
    </header>`;
}

/**
 * @param {object} stats Overview stats { total }
 * @param {object} counts Status category counts
 * @returns {string}
 */
export function renderControlsBar(stats, counts) {
  const openCount = counts.open || 0;
  const progressCount = counts.in_progress || 0;
  const pendingQualcommCount = counts.pending_qualcomm || 0;
  const pendingCustomerCount = counts.pending_customer || 0;
  const actionCount = counts.action_required || 0;
  const closedCount = counts.closed || 0;
  return `    <div class="controls-bar">
      <div class="search-box">
        <input id="searchInput" class="search-input" type="search" placeholder="Search case ID, title, product, comment...">
      </div>
      <div class="filter-tabs">
        <button class="filter-tab active" data-filter="all" type="button">All (${stats.total})</button>
        <button class="filter-tab" data-filter="open" type="button">Open (${openCount})</button>
        <button class="filter-tab" data-filter="in_progress" type="button">In Progress (${progressCount})</button>
        <button class="filter-tab" data-filter="pending_qualcomm" type="button">Pending Qualcomm (${pendingQualcommCount})</button>
        <button class="filter-tab" data-filter="pending_customer" type="button">Pending Customer (${pendingCustomerCount})</button>
        <button class="filter-tab" data-filter="action_required" type="button">Action Required (${actionCount})</button>
        <button class="filter-tab" data-filter="closed" type="button">Closed (${closedCount})</button>
        <button class="filter-tab" data-filter="hidden" type="button">Hidden Cases (<span id="hiddenCount">0</span>)</button>
      </div>
    </div>`;
}

/**
 * @param {string} rowsHtml Concatenated HTML rows
 * @returns {string}
 */
export function renderCasesTable(rowsHtml) {
  return `    <div class="table-wrap">
      <table class="cases-table">
        <thead>
          <tr>
            <th style="width:24px;"></th>
            <th>Case & Details</th>
            <th>Timeline (Always)</th>
            <th>Status & Priority</th>
            <th>Activity (Always)</th>
            <th style="text-align:right;">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>`;
}

/**
 * @returns {string}
 */
export function renderProtocolModal() {
  return `    <!-- Protocol Help Modal -->
    <div id="protocolModal" class="modal-overlay" aria-hidden="true">
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <div class="modal-header">
          <h2 id="modalTitle" class="modal-title">⚙️ Protocol Help</h2>
          <button id="closeModalBtn" class="modal-close-btn" type="button" aria-label="Close modal">&times;</button>
        </div>
        <div class="modal-body">
          <div class="cmd-box">
            <code id="protocolCmdText" class="cmd-text">powershell -ExecutionPolicy Bypass -File .claude/skills/qcomm/scripts/register_protocol.ps1</code>
            <button id="copyProtocolCmdBtn" class="copy-cmd-btn" type="button" title="Copy PowerShell registration command">Copy Command</button>
          </div>
          <div class="cmd-box-alt">
            <span>Or via npm:</span>
            <code id="npmCmdText" class="cmd-text-inline">npm run setup:protocol</code>
            <button id="copyNpmCmdBtn" class="copy-cmd-btn-sm" type="button" title="Copy npm command">Copy</button>
          </div>
        </div>
      </div>
    </div>`;
}

/**
 * @param {object} overviewData
 * @param {string|null} [outputPath=null] Optional output path to write dashboard file
 * @returns {string} The complete HTML document string
 */
export function renderDashboardHtml(overviewData, outputPath = null) {
  const cases = overviewData.cases || [];
  const stats = overviewData.stats || { total: 0, byStatus: {}, lastUpdated: new Date().toISOString() };

  const counts = {
    open: 0,
    in_progress: 0,
    closed: 0,
    action_required: 0,
    pending_qualcomm: 0,
    pending_customer: 0,
  };

  for (const c of cases) {
    const cat = getStatusCategory(c.status, c.ballInCourt);
    if (counts[cat] !== undefined) {
      counts[cat]++;
    }
  }

  const rowsHtml = cases.map((c) => renderCaseRow(c)).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en" data-theme="auto">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Qualcomm Cases Dashboard</title>
${renderStyles()}
</head>
<body>
  <div class="container">
${renderHeader(stats)}

${renderControlsBar(stats, counts)}

${renderCasesTable(rowsHtml)}

    <div id="emptyState" class="empty-state">
      No Qualcomm cases match the selected filter and search criteria.
    </div>

${renderProtocolModal()}
  </div>

${renderClientScript()}
</body>
</html>`;

  if (outputPath) {
    const parentDir = dirname(outputPath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    writeFileSync(outputPath, html, 'utf8');
  }

  return html;
}
