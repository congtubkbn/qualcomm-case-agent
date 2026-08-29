// Renders the self-contained, offline HTML dashboard for Qualcomm case overview data.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Escapes HTML characters in string to prevent XSS.
 * @param {string|any} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Categorizes status for badge colors and filtering.
 * @param {string} status
 * @returns {'open'|'in_progress'|'closed'|'action_required'|'other'}
 */
export function getStatusCategory(status) {
  if (!status) return 'other';
  const s = status.toLowerCase();
  if (s.includes('action') || s.includes('need info') || s.includes('waiting')) return 'action_required';
  if (s.includes('close')) return 'closed';
  if (s.includes('progress') || s.includes('investigat') || s.includes('fix') || s.includes('pending')) return 'in_progress';
  if (s.includes('open')) return 'open';
  return 'other';
}

/**
 * Generates self-contained, offline HTML Dashboard.
 * @param {object} overviewData
 * @param {string|null} [outputPath=null] Optional output path to write dashboard file
 * @returns {string} The complete HTML document string
 */
export function renderDashboardHtml(overviewData, outputPath = null) {
  const cases = overviewData.cases || [];
  const stats = overviewData.stats || { total: 0, byStatus: {}, lastUpdated: new Date().toISOString() };

  let openCount = 0;
  let progressCount = 0;
  let closedCount = 0;
  let actionCount = 0;

  for (const c of cases) {
    const cat = getStatusCategory(c.status);
    if (cat === 'open') openCount++;
    else if (cat === 'in_progress') progressCount++;
    else if (cat === 'closed') closedCount++;
    else if (cat === 'action_required') actionCount++;
  }

  const rowsHtml = cases.map((c) => {
    const category = getStatusCategory(c.status);
    const escapedCaseNum = escapeHtml(c.caseNumber);
    const escapedTitle = escapeHtml(c.title || 'Untitled Case');
    const escapedStatus = escapeHtml(c.status || 'Unknown');
    const escapedPriority = escapeHtml(c.priority || '');
    const escapedProduct = escapeHtml(c.product || '');
    const escapedAiSummary = escapeHtml(c.aiSummary || '');
    const escapedSyncedAt = escapeHtml(c.syncedAt || '');
    const escapedRaisedBy = escapeHtml(c.raisedBy || '');
    const escapedOpenedAt = escapeHtml(c.openedAt || '');
    const commentCount = c.commentCount || 0;

    // Searchable text index for client-side filtering
    const searchTokens = [
      c.caseNumber,
      c.title,
      c.product,
      c.customerProject,
      c.raisedBy,
      c.contactName,
      c.status,
      c.priority,
      c.openedAt,
      c.aiSummary,
      ...(c.latestComments || []).map((cm) => `${cm.author} ${cm.snippet}`),
    ]
      .filter(Boolean)
      .join(' ');
    const escapedSearchIndex = escapeHtml(searchTokens);

    const escapedCustomerProject = escapeHtml(c.customerProject || '');
    const projectBadge = escapedCustomerProject
      ? ` <span class="badge badge-project">${escapedCustomerProject}</span>`
      : '';

    let summaryBlock = '';
    if (c.hasSummary && escapedAiSummary) {
      summaryBlock = `
        <div class="ai-summary">
          <span class="ai-summary-label">Executive:</span>
          <span>${escapedAiSummary}</span>
        </div>`;
    }

    let commentsSection = '';
    if (c.latestComments && c.latestComments.length > 0) {
      const itemsHtml = c.latestComments
        .map((cm) => {
          return `
          <div class="comment-item">
            <div class="comment-header">
              <span class="comment-author">${escapeHtml(cm.author || 'Author')}</span>
              <span>${escapeHtml(cm.timestamp || '')}</span>
            </div>
            <div class="comment-body">${escapeHtml(cm.snippet)}</div>
          </div>`;
        })
        .join('');

      commentsSection = `
        <div class="comments-collapse-wrap">
          <button class="comments-toggle-btn" type="button">
            <span class="chevron">▸</span>
            <span>Recent Updates (${c.latestComments.length})</span>
          </button>
          <div class="comments-list comments-drawer">
            ${itemsHtml}
          </div>
        </div>`;
    }

    const metaLine = [
      escapedRaisedBy ? `Raised by: ${escapedRaisedBy}` : '',
      escapedCustomerProject ? `Project: ${escapedCustomerProject}` : '',
      escapedOpenedAt ? `Opened: ${escapedOpenedAt}` : '',
      escapedSyncedAt ? `Synced: ${escapedSyncedAt.slice(0, 10)}` : '',
      c.lastCommentAuthor ? `Latest by: ${escapeHtml(c.lastCommentAuthor)}` : '',
    ]
      .filter(Boolean)
      .map((part) => `<span>${part}</span>`)
      .join('');

    const caseNumElement = `<a href="qc://case/${escapedCaseNum}" class="case-number" title="Open in Qualcomm Profile (qc://)">#${escapedCaseNum}</a>`;

    const titleElement = `<a href="qc://case/${escapedCaseNum}" title="Open in Qualcomm Profile (qc://)">${escapedTitle}</a>`;

    let priorityClass = 'pri-normal';
    if (c.priority) {
      const p = String(c.priority).toLowerCase();
      if (p.includes('1') || p.includes('critical')) priorityClass = 'pri-critical';
      else if (p.includes('2') || p.includes('high')) priorityClass = 'pri-high';
    }

    const projectDisplay = escapedCustomerProject || escapedProduct;
    const openedDisplay = escapedOpenedAt || '-';
    const syncedDisplay = escapedSyncedAt ? escapedSyncedAt.slice(0, 10) : '-';
    const lastAuthorDisplay = c.lastCommentAuthor ? escapeHtml(c.lastCommentAuthor) : '-';

    return `
      <tr class="case-row" data-case-id="${escapedCaseNum}" data-status-category="${category}" data-search="${escapedSearchIndex}">
        <td class="caret-cell"><span class="caret">▸</span></td>
        <td>
          <div class="case-col">
            <div class="case-top">
              <span class="cell-case">${caseNumElement}</span>
              <span class="cell-title">${titleElement}</span>
            </div>
            <div class="case-meta-subline">
              <span>Project: <strong>${projectDisplay}</strong></span>${projectBadge}
              <span class="meta-dot">&bull;</span>
              <span>Raised by: <strong>${escapedRaisedBy || '-'}</strong></span>
            </div>
          </div>
        </td>
        <td>
          <div class="time-col">
            <span>🕒 Opened: ${openedDisplay}</span>
            <span>🔄 Synced: ${syncedDisplay}</span>
          </div>
        </td>
        <td>
          <div class="status-col">
            <div><span class="status-tag status-tag-${category}" title="${escapedStatus}">${escapedStatus}</span></div>
            <div><span class="pri-badge ${priorityClass}">${escapedPriority}</span></div>
          </div>
        </td>
        <td>
          <div class="activity-col">
            <span>Latest by: <strong>${lastAuthorDisplay}</strong></span>
            <span class="activity-comm-count">💬 ${commentCount} comments</span>
          </div>
        </td>
        <td class="actions-cell">
          <button class="action-btn copy-btn" data-case-id="${escapedCaseNum}" title="Copy Case ID" type="button">📋</button>
          <button class="action-btn hide-btn" data-case-id="${escapedCaseNum}" title="Hide Case from active views" type="button">🚫</button>
          <button class="action-btn unhide-btn" data-case-id="${escapedCaseNum}" title="Unhide Case to active views" type="button">👁️</button>
          <button class="action-btn delete-btn" data-case-id="${escapedCaseNum}" title="🗑️ Delete: Copy chat instruction" type="button">🗑️</button>
        </td>
      </tr>
      <tr class="detail-row" data-case-detail="${escapedCaseNum}">
        <td colspan="6">
          <div class="meta-row">${metaLine}</div>
          ${summaryBlock}
          ${commentsSection}
        </td>
      </tr>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en" data-theme="auto">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Qualcomm Cases Dashboard</title>
  <style>
    :root {
      --bg: #fafaf9;
      --card-bg: #ffffff;
      --text-primary: #18181b;
      --text-secondary: #52525b;
      --text-muted: #a1a1aa;
      --border: #d4d4d8;
      --border-strong: #a1a1aa;
      --border-subtle: #f4f4f5;
      --accent: #1d4ed8;
      --accent-hover: #1e40af;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --badge-open-bg: #eff6ff;
      --badge-open-text: #1d4ed8;
      --badge-progress-text: #b45309;
      --badge-closed-text: #52525b;
      --badge-action-bg: #fef2f2;
      --badge-action-text: #b91c1c;
      --badge-p1-bg: #fef2f2;
      --badge-p1-text: #b91c1c;
      --badge-p2-bg: #fff7ed;
      --badge-p2-text: #c2410c;
      --summary-bg: #f0fdf4;
      --summary-border: #bbf7d0;
      --summary-text: #166534;
      --shadow-sm: 0 1px 3px 0 rgb(0 0 0 / 0.08);
      --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1);
      --radius-sm: 6px;
      --radius-md: 10px;
      --radius-lg: 14px;
    }

    [data-theme="dark"] {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --text-primary: #f8fafc;
      --text-secondary: #cbd5e1;
      --text-muted: #64748b;
      --border: #334155;
      --border-strong: #475569;
      --border-subtle: #182234;
      --accent: #3b82f6;
      --accent-hover: #60a5fa;
      --badge-open-bg: rgba(59, 130, 246, 0.15);
      --badge-open-text: #93c5fd;
      --badge-progress-text: #fcd34d;
      --badge-closed-text: #cbd5e1;
      --badge-action-bg: rgba(239, 68, 68, 0.15);
      --badge-action-text: #fca5a5;
      --badge-p1-bg: rgba(239, 68, 68, 0.2);
      --badge-p1-text: #fca5a5;
      --badge-p2-bg: rgba(249, 115, 22, 0.2);
      --badge-p2-text: #fdba74;
      --summary-bg: rgba(34, 197, 94, 0.1);
      --summary-border: rgba(34, 197, 94, 0.25);
      --summary-text: #86efac;
      --shadow-sm: 0 1px 3px 0 rgb(0 0 0 / 0.3);
      --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.3);
    }

    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        --bg: #0f172a;
        --card-bg: #1e293b;
        --text-primary: #f8fafc;
        --text-secondary: #cbd5e1;
        --text-muted: #64748b;
        --border: #334155;
        --border-strong: #475569;
        --border-subtle: #182234;
        --accent: #3b82f6;
        --accent-hover: #60a5fa;
        --badge-open-bg: rgba(59, 130, 246, 0.15);
        --badge-open-text: #93c5fd;
        --badge-progress-text: #fcd34d;
        --badge-closed-text: #cbd5e1;
        --badge-action-bg: rgba(239, 68, 68, 0.15);
        --badge-action-text: #fca5a5;
        --badge-p1-bg: rgba(239, 68, 68, 0.2);
        --badge-p1-text: #fca5a5;
        --badge-p2-bg: rgba(249, 115, 22, 0.2);
        --badge-p2-text: #fdba74;
        --summary-bg: rgba(34, 197, 94, 0.1);
        --summary-border: rgba(34, 197, 94, 0.25);
        --summary-text: #86efac;
      }
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background-color: var(--bg);
      color: var(--text-primary);
      line-height: 1.5;
      padding: 24px;
      transition: background-color 0.2s ease, color 0.2s ease;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    .brand-title {
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0.01em;
    }
    .meta {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .header-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
    }
    .toolbar-pill {
      display: flex;
      align-items: center;
      gap: 2px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 3px;
    }
    .pill-divider {
      width: 1px;
      height: 18px;
      background: var(--border);
      margin: 0 2px;
    }
    .icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      border: none;
      border-radius: 999px;
      background: transparent;
      color: var(--text-primary);
      font-size: 15px;
      line-height: 1;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .icon-btn:hover {
      background: var(--badge-open-bg);
      color: var(--accent);
    }
    .icon-btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .interval-wrap {
      position: relative;
    }
    .interval-popover {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      display: none;
      flex-direction: column;
      min-width: 84px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      box-shadow: var(--shadow-md);
      padding: 4px;
      z-index: 20;
    }
    .interval-popover.open {
      display: flex;
    }
    .interval-popover button {
      all: unset;
      box-sizing: border-box;
      width: 100%;
      padding: 6px 10px;
      font-family: var(--mono);
      font-size: 11.5px;
      color: var(--text-secondary);
      border-radius: 5px;
      cursor: pointer;
    }
    .interval-popover button:hover {
      background: var(--badge-open-bg);
      color: var(--accent);
    }
    .interval-popover button.active {
      color: var(--accent);
      font-weight: 700;
    }
    .controls-bar {
      display: flex;
      flex-direction: column;
      gap: 14px;
      margin-bottom: 24px;
    }
    @media (min-width: 768px) {
      .controls-bar {
        flex-direction: row;
        align-items: center;
        justify-content: space-between;
      }
    }
    .search-box {
      flex: 1;
      max-width: 480px;
      position: relative;
    }
    .search-input {
      width: 100%;
      padding: 7px 10px;
      border: 1px solid var(--border);
      background: var(--card-bg);
      color: var(--text-primary);
      font-size: 13px;
      outline: none;
      transition: border-color 0.15s ease;
    }
    .search-input:focus {
      border-color: var(--accent);
      outline: 1px solid var(--accent);
      outline-offset: 1px;
    }
    .filter-tabs {
      display: flex;
      flex-wrap: wrap;
      border: 1px solid var(--border);
      width: fit-content;
    }
    .filter-tab {
      background: var(--card-bg);
      border: none;
      border-right: 1px solid var(--border);
      color: var(--text-secondary);
      padding: 7px 12px;
      font-family: var(--mono);
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .filter-tab:last-child {
      border-right: none;
    }
    .filter-tab:hover {
      color: var(--text-primary);
    }
    .filter-tab.active {
      background: var(--text-primary);
      color: var(--card-bg);
    }
    .table-wrap {
      overflow-x: auto;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-sm);
    }
    .cases-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .cases-table thead th {
      text-align: left;
      font-family: var(--mono);
      font-size: 10.5px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border-strong);
      padding: 8px 12px;
      white-space: nowrap;
    }
    tr.case-row {
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      transition: background-color 0.1s ease;
    }
    tr.case-row:hover {
      background: var(--border-subtle);
    }
    tr.case-row.hidden {
      display: none !important;
    }
    tr.case-row td {
      padding: 9px 12px;
      vertical-align: middle;
    }
    tr.detail-row {
      display: none;
    }
    tr.detail-row td {
      background: var(--border-subtle);
      border-bottom: 1px solid var(--border);
      padding: 12px 16px 16px;
    }
    tr.case-row.expanded + tr.detail-row {
      display: table-row;
    }
    .caret-cell {
      width: 20px;
      text-align: center;
    }
    .caret {
      color: var(--text-muted);
      font-size: 11px;
      display: inline-block;
    }
    .case-col {
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 320px;
      max-width: 480px;
    }
    .case-top {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .cell-case {
      font-family: var(--mono);
      white-space: nowrap;
    }
    .case-number {
      font-family: var(--mono);
      font-weight: 700;
      font-size: 13px;
      color: var(--accent);
      text-decoration: none;
    }
    a.case-number:hover {
      text-decoration: underline;
      color: var(--accent-hover);
    }
    .cell-title {
      max-width: 380px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }
    .cell-title a {
      color: var(--text-primary);
      text-decoration: none;
    }
    .cell-title a:hover {
      color: var(--accent);
      text-decoration: underline;
    }
    .case-meta-subline {
      font-size: 11.5px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .case-meta-subline strong {
      color: var(--text-secondary);
      font-weight: 500;
    }
    .meta-dot {
      color: var(--text-muted);
      opacity: 0.6;
    }
    .time-col {
      font-family: var(--mono);
      font-size: 11.5px;
      color: var(--text-secondary);
      display: flex;
      flex-direction: column;
      gap: 2px;
      white-space: nowrap;
    }
    .status-col {
      display: flex;
      flex-direction: column;
      gap: 4px;
      white-space: nowrap;
    }
    .pri-badge {
      display: inline-block;
      font-family: var(--mono);
      font-size: 10px;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 4px;
      width: fit-content;
    }
    .pri-critical {
      background: var(--badge-p1-bg);
      color: var(--badge-p1-text);
    }
    .pri-high {
      background: var(--badge-p2-bg);
      color: var(--badge-p2-text);
    }
    .pri-normal {
      background: var(--border-subtle);
      color: var(--text-secondary);
    }
    .activity-col {
      font-size: 11.5px;
      color: var(--text-secondary);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .activity-comm-count {
      color: var(--text-muted);
    }
    .actions-cell {
      display: flex;
      gap: 4px;
      align-items: center;
      justify-content: flex-end;
    }
    .action-btn, .copy-btn, .hide-btn, .unhide-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-secondary);
      font-family: var(--mono);
      width: 28px;
      height: 28px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
      text-decoration: none;
    }
    .action-btn:hover, .copy-btn:hover {
      background: var(--border-subtle);
      border-color: var(--border);
      color: var(--text-primary);
    }
    .copy-btn.copied, .delete-btn.copied {
      background: var(--summary-bg) !important;
      color: var(--summary-text) !important;
      border-color: var(--summary-border) !important;
    }
    .hide-btn:hover {
      background: var(--badge-action-bg);
      color: var(--badge-action-text);
      border-color: rgba(239, 68, 68, 0.3);
    }
    .delete-btn:hover {
      background: var(--badge-action-bg);
      color: var(--badge-action-text);
      border-color: rgba(239, 68, 68, 0.3);
    }
    .unhide-btn {
      display: none;
    }
    .unhide-btn:hover {
      background: var(--summary-bg);
      color: var(--summary-text);
      border-color: var(--summary-border);
    }
    body[data-active-filter="hidden"] .hide-btn {
      display: none !important;
    }
    body[data-active-filter="hidden"] .unhide-btn {
      display: inline-flex !important;
    }
    body:not([data-active-filter="hidden"]) .unhide-btn {
      display: none !important;
    }
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.65);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease;
    }
    .modal-overlay.active {
      opacity: 1;
      pointer-events: auto;
    }
    .modal-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      max-width: 640px;
      width: calc(100% - 32px);
      max-height: 85vh;
      overflow-y: auto;
      box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.25), 0 8px 10px -6px rgb(0 0 0 / 0.25);
      transform: translateY(16px) scale(0.98);
      transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .modal-overlay.active .modal-card {
      transform: translateY(0) scale(1);
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }
    .modal-title {
      font-size: 18px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .modal-close-btn {
      background: transparent;
      border: none;
      font-size: 24px;
      line-height: 1;
      color: var(--text-muted);
      cursor: pointer;
      padding: 4px 8px;
      border-radius: var(--radius-sm);
      transition: color 0.15s ease, background 0.15s ease;
    }
    .modal-close-btn:hover {
      color: var(--text-primary);
      background: var(--border-subtle);
    }
    .modal-body {
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .comparison-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
    }
    @media (min-width: 580px) {
      .comparison-grid {
        grid-template-columns: 1fr 1fr;
      }
    }
    .comparison-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 14px;
      font-size: 13px;
      line-height: 1.45;
      color: var(--text-secondary);
    }
    .comparison-header {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 8px;
    }
    .comparison-header strong {
      color: var(--text-primary);
      font-size: 13px;
    }
    .mode-tag {
      display: inline-block;
      align-self: flex-start;
      font-size: 11px;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 9999px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .mode-qc {
      background: var(--badge-open-bg);
      color: var(--badge-open-text);
    }
    .mode-web {
      background: var(--summary-bg);
      color: var(--summary-text);
    }
    .cmd-box {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 10px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .cmd-text {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--text-primary);
      word-break: break-all;
    }
    .copy-cmd-btn, .copy-cmd-btn-sm {
      background: var(--card-bg);
      border: 1px solid var(--border);
      color: var(--text-primary);
      padding: 6px 12px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s ease;
      flex-shrink: 0;
    }
    .copy-cmd-btn-sm {
      padding: 3px 8px;
      font-size: 11px;
    }
    .copy-cmd-btn:hover, .copy-cmd-btn-sm:hover {
      background: var(--accent);
      color: #ffffff;
      border-color: var(--accent);
    }
    .copy-cmd-btn.copied, .copy-cmd-btn-sm.copied {
      background: var(--summary-bg) !important;
      color: var(--summary-text) !important;
      border-color: var(--summary-border) !important;
    }
    .cmd-box-alt {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      font-size: 12px;
      color: var(--text-muted);
    }
    .cmd-text-inline {
      font-family: var(--mono);
      background: var(--bg);
      border: 1px solid var(--border);
      padding: 2px 6px;
      border-radius: var(--radius-sm);
      color: var(--text-primary);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 3px 8px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .badge-project { background: var(--border-subtle); color: var(--text-secondary); border: 1px solid var(--border); margin-left: 4px; }
    .status-tag {
      display: inline-block;
      font-family: var(--mono);
      font-size: 10.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 1px 6px;
      border: 1px solid currentColor;
      white-space: nowrap;
    }
    .status-tag-open { color: var(--badge-open-text); }
    .status-tag-in_progress { color: var(--badge-progress-text); }
    .status-tag-closed { color: var(--badge-closed-text); }
    .status-tag-action_required { color: var(--badge-action-text); }
    .status-tag-other { color: var(--text-muted); }
    .ai-summary {
      background: var(--summary-bg);
      border: 1px solid var(--summary-border);
      color: var(--summary-text);
      border-radius: var(--radius-md);
      padding: 10px 14px;
      font-size: 13px;
      margin-bottom: 12px;
      display: flex;
      gap: 8px;
      align-items: baseline;
      line-height: 1.45;
    }
    .ai-summary-label {
      font-weight: 700;
      flex-shrink: 0;
    }
    .meta-row {
      font-size: 12px;
      color: var(--text-muted);
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      margin-bottom: 12px;
    }
    .detail-label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-muted);
      margin-top: 10px;
      border-top: 1px solid var(--border);
      padding-top: 10px;
    }
    .comments-collapse-wrap {
      margin-top: 10px;
    }
    .comments-toggle-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      color: var(--text-secondary);
      font-family: var(--mono);
      font-size: 11.5px;
      font-weight: 600;
      padding: 5px 12px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .comments-toggle-btn:hover {
      background: var(--border-subtle);
      color: var(--text-primary);
      border-color: var(--border-strong);
    }
    .comments-toggle-btn .chevron {
      font-size: 10px;
      transition: transform 0.2s ease;
      display: inline-block;
    }
    .comments-toggle-btn.expanded .chevron {
      transform: rotate(90deg);
    }
    .comments-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 10px;
      padding-left: 4px;
    }
    .comments-drawer {
      display: none;
    }
    .comments-drawer.open {
      display: flex;
    }
    .comment-item {
      background: var(--border-subtle);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 8px 12px;
      font-size: 13px;
    }
    .comment-header {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 4px;
      font-size: 12px;
      color: var(--text-secondary);
    }
    .comment-author {
      font-weight: 600;
      color: var(--text-primary);
    }
    .comment-body {
      color: var(--text-secondary);
      word-break: break-word;
    }
    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--text-muted);
      font-size: 15px;
      display: none;
    }
    .empty-state.visible {
      display: block;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
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
    </header>

    <div class="controls-bar">
      <div class="search-box">
        <input id="searchInput" class="search-input" type="search" placeholder="Search case ID, title, product, comment...">
      </div>
      <div class="filter-tabs">
        <button class="filter-tab active" data-filter="all" type="button">All (${stats.total})</button>
        <button class="filter-tab" data-filter="open" type="button">Open (${openCount})</button>
        <button class="filter-tab" data-filter="in_progress" type="button">In Progress (${progressCount})</button>
        <button class="filter-tab" data-filter="action_required" type="button">Action Required (${actionCount})</button>
        <button class="filter-tab" data-filter="closed" type="button">Closed (${closedCount})</button>
        <button class="filter-tab" data-filter="hidden" type="button">Hidden Cases (<span id="hiddenCount">0</span>)</button>
      </div>
    </div>

    <div class="table-wrap">
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
    </div>

    <div id="emptyState" class="empty-state">
      No Qualcomm cases match the selected filter and search criteria.
    </div>

    <!-- Protocol Help Modal -->
    <div id="protocolModal" class="modal-overlay" aria-hidden="true">
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <div class="modal-header">
          <h2 id="modalTitle" class="modal-title">⚙️ Protocol Help</h2>
          <button id="closeModalBtn" class="modal-close-btn" type="button" aria-label="Close modal">&times;</button>
        </div>
        <div class="modal-body">
          <div class="cmd-box">
            <code id="protocolCmdText" class="cmd-text">powershell -ExecutionPolicy Bypass -File scripts/register_protocol.ps1</code>
            <button id="copyProtocolCmdBtn" class="copy-cmd-btn" type="button" title="Copy PowerShell registration command">Copy Command</button>
          </div>
          <div class="cmd-box-alt">
            <span>Or via npm:</span>
            <code id="npmCmdText" class="cmd-text-inline">npm run setup:protocol</code>
            <button id="copyNpmCmdBtn" class="copy-cmd-btn-sm" type="button" title="Copy npm command">Copy</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    document.addEventListener('DOMContentLoaded', () => {
      const searchInput = document.getElementById('searchInput');
      const filterTabs = document.querySelectorAll('.filter-tab');
      const rows = document.querySelectorAll('.case-row');
      const emptyState = document.getElementById('emptyState');
      const themeToggle = document.getElementById('themeToggle');
      const hiddenCountEl = document.getElementById('hiddenCount');
      const intervalBtn = document.getElementById('intervalBtn');
      const intervalPopover = document.getElementById('intervalPopover');
      const refreshNowBtn = document.getElementById('refreshNowBtn');
      const protocolHelpBtn = document.getElementById('protocolHelpBtn');
      const protocolModal = document.getElementById('protocolModal');
      const closeModalBtn = document.getElementById('closeModalBtn');
      const copyProtocolCmdBtn = document.getElementById('copyProtocolCmdBtn');
      const copyNpmCmdBtn = document.getElementById('copyNpmCmdBtn');

      // Row click toggles the adjacent detail row (AI summary + recent comments).
      rows.forEach(row => {
        row.addEventListener('click', (e) => {
          if (e.target.closest('button') || e.target.closest('a')) return;
          if (row.classList.contains('hidden')) return;
          const isOpen = row.classList.toggle('expanded');
          const caretEl = row.querySelector('.caret');
          if (caretEl) caretEl.textContent = isOpen ? '▾' : '▸';
        });
      });

      const STORAGE_KEY_HIDDEN = 'qc_dashboard_hidden_cases';
      const STORAGE_KEY_THEME = 'qc_dashboard_theme';
      const STORAGE_KEY_FILTER = 'qc_dashboard_active_filter';
      const STORAGE_KEY_SEARCH = 'qc_dashboard_search_query';
      const STORAGE_KEY_REFRESH = 'qc_dashboard_refresh_interval';

      function safeStorageGet(key, fallback = null) {
        try {
          const val = localStorage.getItem(key);
          return val !== null ? val : fallback;
        } catch {
          return fallback;
        }
      }

      function safeStorageSet(key, value) {
        try {
          localStorage.setItem(key, value);
        } catch {}
      }

      let hiddenCases = new Set();
      try {
        const stored = safeStorageGet(STORAGE_KEY_HIDDEN);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed)) {
            hiddenCases = new Set(parsed);
          }
        }
      } catch {
        hiddenCases = new Set();
      }

      function saveHiddenCases() {
        safeStorageSet(STORAGE_KEY_HIDDEN, JSON.stringify(Array.from(hiddenCases)));
      }

      function updateHiddenCount() {
        if (hiddenCountEl) {
          hiddenCountEl.textContent = hiddenCases.size;
        }
      }

      // Restore active filter tab from localStorage
      let currentFilter = safeStorageGet(STORAGE_KEY_FILTER, 'all');
      const validFilter = Array.from(filterTabs).some(t => t.getAttribute('data-filter') === currentFilter);
      if (!validFilter) {
        currentFilter = 'all';
      }
      filterTabs.forEach(t => {
        if (t.getAttribute('data-filter') === currentFilter) {
          t.classList.add('active');
        } else {
          t.classList.remove('active');
        }
      });

      // Restore search query from localStorage
      let currentSearch = safeStorageGet(STORAGE_KEY_SEARCH, '');
      if (searchInput && currentSearch) {
        searchInput.value = currentSearch;
      }

      function applyFilters() {
        document.body.setAttribute('data-active-filter', currentFilter);
        let visibleCount = 0;
        const query = currentSearch.toLowerCase().trim();

        rows.forEach(row => {
          const rowId = row.getAttribute('data-case-id') || '';
          const rowCategory = row.getAttribute('data-status-category') || '';
          const rowText = (row.getAttribute('data-search') || '').toLowerCase();
          const isHidden = hiddenCases.has(rowId);

          let matchesFilter = false;
          if (currentFilter === 'hidden') {
            matchesFilter = isHidden;
          } else {
            if (isHidden) {
              matchesFilter = false;
            } else {
              matchesFilter = (currentFilter === 'all') || (rowCategory === currentFilter);
            }
          }

          const matchesSearch = !query || rowText.includes(query);

          if (matchesFilter && matchesSearch) {
            row.classList.remove('hidden');
            visibleCount++;
          } else {
            row.classList.add('hidden');
            row.classList.remove('expanded');
            const caretEl = row.querySelector('.caret');
            if (caretEl) caretEl.textContent = '▸';
          }
        });

        if (emptyState) {
          if (visibleCount === 0) {
            emptyState.textContent = currentFilter === 'hidden'
              ? 'No hidden cases. Click "Hide" on any case row to move it here.'
              : 'No Qualcomm cases match the selected filter and search criteria.';
            emptyState.classList.add('visible');
          } else {
            emptyState.classList.remove('visible');
          }
        }
      }

      if (searchInput) {
        searchInput.addEventListener('input', (e) => {
          currentSearch = e.target.value;
          safeStorageSet(STORAGE_KEY_SEARCH, currentSearch);
          applyFilters();
        });
      }

      filterTabs.forEach(tab => {
        tab.addEventListener('click', () => {
          filterTabs.forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          currentFilter = tab.getAttribute('data-filter');
          safeStorageSet(STORAGE_KEY_FILTER, currentFilter);
          applyFilters();
        });
      });

      // Hide buttons
      document.querySelectorAll('.hide-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const caseId = btn.getAttribute('data-case-id');
          if (caseId) {
            hiddenCases.add(caseId);
            saveHiddenCases();
            updateHiddenCount();
            applyFilters();
          }
        });
      });

      // Unhide buttons
      document.querySelectorAll('.unhide-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const caseId = btn.getAttribute('data-case-id');
          if (caseId) {
            hiddenCases.delete(caseId);
            saveHiddenCases();
            updateHiddenCount();
            applyFilters();
          }
        });
      });

      // Shared clipboard-copy path (Copy ID, Delete instruction, Protocol Cmds).
      async function copyTextToClipboard(text) {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const textArea = document.createElement('textarea');
          textArea.value = text;
          document.body.appendChild(textArea);
          textArea.select();
          document.execCommand('copy');
          document.body.removeChild(textArea);
        }
      }

      function flashCopied(btn, restingIcon) {
        btn.textContent = '✓';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = restingIcon;
          btn.classList.remove('copied');
        }, 1200);
      }

      // Copy ID buttons
      document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const caseId = btn.getAttribute('data-case-id');
          if (caseId) {
            await copyTextToClipboard(caseId);
            flashCopied(btn, '📋');
          }
        });
      });

      // Delete buttons — copy a natural-language chat instruction only.
      // Never a CLI command: per ADR 0003 the dashboard must not produce
      // anything pasteable straight into a terminal to bypass the
      // agent-confirmed delete flow.
      document.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const caseId = btn.getAttribute('data-case-id');
          if (caseId) {
            await copyTextToClipboard(\`xóa case \${caseId} khỏi cache local\`);
            flashCopied(btn, '🗑️');
          }
        });
      });

      // Toggle comments drawer inside detail row
      document.querySelectorAll('.comments-toggle-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const isExpanded = btn.classList.toggle('expanded');
          const chevron = btn.querySelector('.chevron');
          if (chevron) chevron.textContent = isExpanded ? '▾' : '▸';
          const drawer = btn.nextElementSibling;
          if (drawer) drawer.classList.toggle('open', isExpanded);
        });
      });

      // Protocol Help Modal
      function openModal() {
        if (protocolModal) {
          protocolModal.classList.add('active');
          protocolModal.setAttribute('aria-hidden', 'false');
          document.body.style.overflow = 'hidden';
        }
      }

      function closeModal() {
        if (protocolModal) {
          protocolModal.classList.remove('active');
          protocolModal.setAttribute('aria-hidden', 'true');
          document.body.style.overflow = '';
        }
      }

      if (protocolHelpBtn) {
        protocolHelpBtn.addEventListener('click', openModal);
      }

      if (closeModalBtn) {
        closeModalBtn.addEventListener('click', closeModal);
      }

      if (protocolModal) {
        protocolModal.addEventListener('click', (e) => {
          if (e.target === protocolModal) {
            closeModal();
          }
        });
      }

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && protocolModal && protocolModal.classList.contains('active')) {
          closeModal();
        }
      });

      if (copyProtocolCmdBtn) {
        copyProtocolCmdBtn.addEventListener('click', async () => {
          const cmd = 'powershell -ExecutionPolicy Bypass -File scripts/register_protocol.ps1';
          await copyTextToClipboard(cmd);
          flashCopied(copyProtocolCmdBtn, 'Copy Command');
        });
      }

      if (copyNpmCmdBtn) {
        copyNpmCmdBtn.addEventListener('click', async () => {
          const cmd = 'npm run setup:protocol';
          await copyTextToClipboard(cmd);
          flashCopied(copyNpmCmdBtn, 'Copy');
        });
      }

      // Theme toggle — icon-only, glyph reflects the active theme (no visible label)
      if (themeToggle) {
        function effectiveIsDark() {
          const current = document.documentElement.getAttribute('data-theme');
          if (current === 'dark') return true;
          if (current === 'light') return false;
          return window.matchMedia('(prefers-color-scheme: dark)').matches;
        }

        function syncThemeIcon() {
          themeToggle.textContent = effectiveIsDark() ? '☀️' : '🌙';
        }

        const savedTheme = safeStorageGet(STORAGE_KEY_THEME);
        if (savedTheme) {
          document.documentElement.setAttribute('data-theme', savedTheme);
        }
        syncThemeIcon();

        themeToggle.addEventListener('click', () => {
          const next = effectiveIsDark() ? 'light' : 'dark';
          document.documentElement.setAttribute('data-theme', next);
          safeStorageSet(STORAGE_KEY_THEME, next);
          syncThemeIcon();
        });
      }

      // Auto-refresh countdown timer (default 300s = 5m). No visible ticker text —
      // remaining time surfaces only via the interval button's title tooltip.
      const savedRefreshInterval = safeStorageGet(STORAGE_KEY_REFRESH);
      let refreshSeconds = savedRefreshInterval !== null ? parseInt(savedRefreshInterval, 10) : 300;
      if (isNaN(refreshSeconds)) refreshSeconds = 300;

      let remainingSeconds = refreshSeconds;
      let refreshTimer = null;

      function formatTime(sec) {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      }

      function updateTickerDisplay() {
        if (!intervalBtn) return;
        intervalBtn.title = refreshSeconds <= 0
          ? 'Auto-refresh: Off'
          : 'Auto-refresh in: ' + formatTime(remainingSeconds);
      }

      function startCountdown() {
        if (refreshTimer) {
          clearInterval(refreshTimer);
          refreshTimer = null;
        }
        if (refreshSeconds <= 0) {
          updateTickerDisplay();
          return;
        }
        remainingSeconds = refreshSeconds;
        updateTickerDisplay();
        refreshTimer = setInterval(() => {
          remainingSeconds--;
          if (remainingSeconds <= 0) {
            clearInterval(refreshTimer);
            window.location.reload();
          } else {
            updateTickerDisplay();
          }
        }, 1000);
      }

      // Interval popover — pick an auto-refresh interval directly (Off…15m)
      if (intervalBtn && intervalPopover) {
        function closeIntervalPopover() {
          intervalPopover.classList.remove('open');
          intervalBtn.setAttribute('aria-expanded', 'false');
        }

        intervalBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const isOpen = intervalPopover.classList.toggle('open');
          intervalBtn.setAttribute('aria-expanded', String(isOpen));
        });

        intervalPopover.querySelectorAll('button').forEach(btn => {
          btn.addEventListener('click', () => {
            intervalPopover.querySelectorAll('button').forEach(b => {
              b.classList.remove('active');
              b.setAttribute('aria-checked', 'false');
            });
            btn.classList.add('active');
            btn.setAttribute('aria-checked', 'true');
            refreshSeconds = parseInt(btn.getAttribute('data-val'), 10) || 0;
            safeStorageSet(STORAGE_KEY_REFRESH, String(refreshSeconds));
            startCountdown();
            closeIntervalPopover();
          });
        });

        document.addEventListener('click', closeIntervalPopover);
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') closeIntervalPopover();
        });

        const activeBtn = intervalPopover.querySelector(\`button[data-val="\${refreshSeconds}"]\`);
        if (activeBtn) {
          intervalPopover.querySelectorAll('button').forEach(b => {
            b.classList.remove('active');
            b.setAttribute('aria-checked', 'false');
          });
          activeBtn.classList.add('active');
          activeBtn.setAttribute('aria-checked', 'true');
        }
      }

      if (refreshNowBtn) {
        refreshNowBtn.addEventListener('click', () => {
          window.location.reload();
        });
      }

      startCountdown();

      // Initial filter & hidden count pass
      updateHiddenCount();
      applyFilters();
    });
  </script>
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
