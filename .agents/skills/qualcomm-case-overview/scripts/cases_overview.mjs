// Aggregation engine, CLI summary table, and offline HTML dashboard for Qualcomm cases.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureProtocolRegistered } from '../../../../scripts/ensure_protocol.mjs';

// Discover project data directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function findProjectRoot(start) {
  let d = start;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(join(d, '.git')) || existsSync(join(d, 'data', 'cases'))) return d;
    const parent = dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

const PROJECT_ROOT =
  process.env.QUALCOMM_ROOT || findProjectRoot(__dirname) || resolve(__dirname, '../../../../');
const DEFAULT_CASES_DIR = join(PROJECT_ROOT, 'data', 'cases');

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
 * Normalizes text snippet from a comment (removes duplicate whitespace/newlines, truncates).
 * @param {object} comment
 * @param {number} [maxLen=160]
 * @returns {string}
 */
export function createCommentSnippet(comment, maxLen = 160) {
  if (!comment) return '';
  const text = (comment.summary || comment.body || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

/**
 * Extracts product code from title if product field is missing or empty.
 * e.g. "[DE.3.1.4][SM7635] epsfb_if_emc_and_no_vonr does not work" -> "SM7635"
 * @param {string} title
 * @returns {string}
 */
export function extractProductFromTitle(title) {
  if (!title || typeof title !== 'string') return '';
  const matches = title.match(/\[([A-Za-z0-9_.-]+)\]/g);
  if (!matches) return '';
  for (const m of matches) {
    const raw = m.slice(1, -1);
    // Ignore build/branch prefixes like DE.3.1.4, LA.2.0, etc.
    if (!/^(DE\.|LA\.|LE\.|AU\.|PROD|STD)/i.test(raw)) {
      return raw;
    }
  }
  return '';
}

/**
 * Extracts formatted AI executive summary from summary.json data.
 * @param {object} summaryJson
 * @returns {string|null}
 */
export function extractAiSummary(summaryJson) {
  if (!summaryJson) return null;
  if (typeof summaryJson.executive === 'string') return summaryJson.executive;
  if (summaryJson.executive && typeof summaryJson.executive === 'object') {
    const exec = summaryJson.executive;
    const parts = [];
    if (exec.resolution) parts.push(`Resolution: ${exec.resolution}`);
    if (exec.rootCause) parts.push(`Root cause: ${exec.rootCause}`);
    if (exec.blockerOrNextMilestone && exec.blockerOrNextMilestone !== 'None — fix delivered and case closed') {
      parts.push(`Next: ${exec.blockerOrNextMilestone}`);
    }
    if (parts.length > 0) return parts.join(' | ');
  }
  if (summaryJson.summary && typeof summaryJson.summary === 'string') {
    return summaryJson.summary;
  }
  return null;
}

/**
 * Extracts normalized overview record for a single case directory.
 * @param {string} caseDir Absolute or relative path to case directory
 * @param {string} [caseNumber] Fallback case number
 * @returns {object|null} Case overview object or null if invalid directory
 */
export function extractCaseOverview(caseDir, caseNumber = '') {
  try {
    if (!existsSync(caseDir) || !statSync(caseDir).isDirectory()) {
      return null;
    }

    const caseJsonPath = join(caseDir, 'case.json');
    if (!existsSync(caseJsonPath)) {
      return null;
    }

    const caseRaw = readFileSync(caseJsonPath, 'utf8');
    const caseJson = JSON.parse(caseRaw);

    const actualCaseNumber = caseJson.caseNumber || caseNumber || basename(caseDir);
    const title = caseJson.title || '';
    const status = caseJson.status || 'Unknown';
    const priority = caseJson.priority || '';
    const product = caseJson.product || extractProductFromTitle(title) || '';
    const customerProject = (typeof caseJson.customerProject === 'string' && caseJson.customerProject.trim())
      ? caseJson.customerProject.trim()
      : '';
    const openedAt = (typeof caseJson.openedAt === 'string' && caseJson.openedAt.trim())
      ? caseJson.openedAt.trim()
      : (typeof caseJson.created === 'string' ? caseJson.created.trim() : '');
    const closedAt = (typeof caseJson.closedAt === 'string' && caseJson.closedAt.trim())
      ? caseJson.closedAt.trim()
      : '';
    const contactName = (typeof caseJson.contactName === 'string' && caseJson.contactName.trim())
      ? caseJson.contactName.trim()
      : '';
    const accountName = (typeof caseJson.accountName === 'string' && caseJson.accountName.trim())
      ? caseJson.accountName.trim()
      : (typeof caseJson.customer === 'string' ? caseJson.customer.trim() : '');
    const url = caseJson.url || '';
    const syncedAt = caseJson.extractedAt || caseJson.syncedAt || '';

    // Comments extraction
    const rawComments = Array.isArray(caseJson.comments) ? caseJson.comments : [];
    const commentCount = rawComments.length || caseJson.displayedCommentCount || 0;

    let lastCommentAt = '';
    let lastCommentAuthor = '';
    const latestComments = [];

    if (rawComments.length > 0) {
      // In case.json comments are newest-first (see scrape_case.mjs's
      // orderCommentsForPresentation — supersedes the old Oldest -> Newest order).
      const newestComment = rawComments[0];
      lastCommentAt = newestComment.timestamp || '';
      lastCommentAuthor = newestComment.author || '';

      // Extract up to 3 newest comments (already newest-first, no reverse needed)
      const topRecent = rawComments.slice(0, 3);
      for (const c of topRecent) {
        latestComments.push({
          id: c.id || '',
          author: c.author || '',
          timestamp: c.timestamp || '',
          snippet: createCommentSnippet(c),
        });
      }
    }

    // Opener / creator extraction: strictly prioritize contactName / raisedBy from Detail tab
    const raisedBy =
      contactName ||
      (typeof caseJson.raisedBy === 'string' && caseJson.raisedBy.trim()) ||
      (typeof caseJson.creator === 'string' && caseJson.creator.trim()) ||
      (typeof caseJson.openedBy === 'string' && caseJson.openedBy.trim()) ||
      // Opener = oldest comment, which is now LAST in the newest-first array.
      (rawComments.length > 0 && rawComments[rawComments.length - 1].author ? rawComments[rawComments.length - 1].author : '');

    // Summary extraction
    const summaryJsonPath = join(caseDir, 'summary.json');
    let hasSummary = false;
    let aiSummary = null;

    if (existsSync(summaryJsonPath)) {
      try {
        const summaryRaw = readFileSync(summaryJsonPath, 'utf8');
        const summaryJson = JSON.parse(summaryRaw);
        aiSummary = extractAiSummary(summaryJson);
        hasSummary = true;
      } catch {
        hasSummary = false;
        aiSummary = null;
      }
    }

    return {
      caseNumber: actualCaseNumber,
      title,
      status,
      priority,
      product,
      customerProject,
      openedAt,
      closedAt,
      contactName,
      accountName,
      raisedBy,
      url,
      syncedAt,
      lastCommentAt,
      lastCommentAuthor,
      commentCount,
      hasSummary,
      aiSummary,
      latestComments,
    };
  } catch {
    return null;
  }
}

/**
 * Recomputes overview statistics from an array of cases.
 * @param {Array<object>} cases
 * @returns {object}
 */
export function computeStats(cases) {
  const byStatus = {};
  for (const c of cases) {
    const s = c.status || 'Unknown';
    byStatus[s] = (byStatus[s] || 0) + 1;
  }
  return {
    total: cases.length,
    byStatus,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Scans all case directories in casesDir and aggregates overview data.
 * @param {string} casesDir Directory containing case folders
 * @returns {object} Overview data object containing cases array and stats
 */
export function buildOverviewData(casesDir = DEFAULT_CASES_DIR) {
  if (!existsSync(casesDir)) {
    return {
      cases: [],
      stats: { total: 0, byStatus: {}, lastUpdated: new Date().toISOString() },
    };
  }

  const entries = readdirSync(casesDir, { withFileTypes: true });
  const cases = [];

  for (const entry of entries) {
    // Only process subdirectories that do not start with '.' or '_'
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) {
      continue;
    }

    const dirPath = join(casesDir, entry.name);
    const caseRecord = extractCaseOverview(dirPath, entry.name);
    if (caseRecord) {
      cases.push(caseRecord);
    }
  }

  // Sort cases: most recently synced or higher case number first
  cases.sort((a, b) => {
    if (a.syncedAt && b.syncedAt) {
      return b.syncedAt.localeCompare(a.syncedAt);
    }
    return b.caseNumber.localeCompare(a.caseNumber);
  });

  return {
    cases,
    stats: computeStats(cases),
  };
}

/**
 * Incrementally updates or inserts a single case record in _overview.json atomically.
 * @param {string} caseNumber Case ID (e.g. "08603854")
 * @param {string} casesDir Directory containing case folders
 * @returns {object} The updated overview data
 */
export function updateCaseOverview(caseNumber, casesDir = DEFAULT_CASES_DIR) {
  const overviewPath = join(casesDir, '_overview.json');
  let overviewData;

  if (existsSync(overviewPath)) {
    try {
      overviewData = JSON.parse(readFileSync(overviewPath, 'utf8'));
      if (!overviewData || !Array.isArray(overviewData.cases)) {
        overviewData = buildOverviewData(casesDir);
      }
    } catch {
      overviewData = buildOverviewData(casesDir);
    }
  } else {
    overviewData = buildOverviewData(casesDir);
  }

  const caseDir = join(casesDir, caseNumber);
  const updatedRecord = extractCaseOverview(caseDir, caseNumber);

  if (updatedRecord) {
    const existingIndex = overviewData.cases.findIndex((c) => c.caseNumber === caseNumber);
    if (existingIndex >= 0) {
      overviewData.cases[existingIndex] = updatedRecord;
    } else {
      overviewData.cases.unshift(updatedRecord);
    }
  } else {
    // If case dir is deleted or invalid, remove from overview
    overviewData.cases = overviewData.cases.filter((c) => c.caseNumber !== caseNumber);
  }

  // Re-sort and recompute stats
  overviewData.cases.sort((a, b) => {
    if (a.syncedAt && b.syncedAt) {
      return b.syncedAt.localeCompare(a.syncedAt);
    }
    return b.caseNumber.localeCompare(a.caseNumber);
  });

  overviewData.stats = computeStats(overviewData.cases);

  if (!existsSync(casesDir)) {
    mkdirSync(casesDir, { recursive: true });
  }

  // Atomic write to _overview.json
  const tempPath = join(casesDir, `_overview.json.tmp.${process.pid}.${Date.now()}`);
  writeFileSync(tempPath, JSON.stringify(overviewData, null, 2), 'utf8');
  renameSync(tempPath, overviewPath);

  // Also refresh dashboard.html
  const dashboardPath = join(casesDir, 'dashboard.html');
  renderDashboardHtml(overviewData, dashboardPath);

  return overviewData;
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

/**
 * Renders formatted terminal summary and case table.
 * @param {object} overviewData
 * @param {object} [options={}]
 * @returns {string} Formatted CLI output string
 */
export function renderCliTable(overviewData, options = {}) {
  const data = applyFilter(overviewData, options.filter);
  const cases = data.cases || [];
  const stats = data.stats || { total: 0, byStatus: {}, lastUpdated: '' };

  const lines = [];
  lines.push('================================================================================');
  lines.push(`QUALCOMM CASES OVERVIEW (${cases.length} cases)`);
  lines.push(`Last Updated: ${stats.lastUpdated || new Date().toISOString()}`);

  const statusEntries = Object.entries(stats.byStatus || {});
  if (statusEntries.length > 0) {
    lines.push(`Status: ${statusEntries.map(([k, v]) => `${k}: ${v}`).join(' | ')}`);
  }
  lines.push('================================================================================\n');

  if (cases.length === 0) {
    lines.push('No cases found.\n');
    return lines.join('\n');
  }

  for (const c of cases) {
    const metaParts = [];
    metaParts.push(`Status: ${c.status || 'Unknown'}`);
    if (c.priority) metaParts.push(`Priority: ${c.priority}`);
    if (c.product) metaParts.push(`Product: ${c.product}`);
    if (c.customerProject) metaParts.push(`Project: ${c.customerProject}`);
    if (c.raisedBy) metaParts.push(`Raised by: ${c.raisedBy}`);
    if (c.openedAt) metaParts.push(`Opened: ${c.openedAt}`);
    metaParts.push(`Comments: ${c.commentCount || 0}`);

    lines.push(`[${c.caseNumber}] ${c.title || 'Untitled case'}`);
    lines.push(`  ${metaParts.join(' | ')}`);

    if (c.aiSummary) {
      lines.push(`  Summary: ${c.aiSummary}`);
    }

    if (c.latestComments && c.latestComments.length > 0) {
      const top = c.latestComments[0];
      const author = top.author || 'Unknown';
      const time = top.timestamp || '';
      const header = time ? `(${author}, ${time})` : `(${author})`;
      lines.push(`  Latest: ${header} ${top.snippet}`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Opens a local file in the default OS web browser.
 * @param {string} filePath
 */
export function openInBrowser(filePath) {
  if (process.env.NODE_ENV === 'test' || process.env.QUALCOMM_NO_BROWSER === '1' || process.env.CI) {
    return;
  }
  const platform = process.platform;
  if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '""', filePath], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
  } else if (platform === 'darwin') {
    spawn('open', [filePath], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [filePath], { detached: true, stdio: 'ignore' }).unref();
  }
}

/**
 * Parses CLI arguments.
 * @param {string[]} args
 * @returns {object}
 */
export function parseArgs(args) {
  const parsed = {
    rebuild: false,
    json: false,
    html: false,
    open: false,
    noOpen: false,
    filter: null,
    casesDir: DEFAULT_CASES_DIR,
    help: false,
  };

  let explicitOpen = false;
  let explicitNoOpen = false;

  for (const arg of args) {
    if (arg === '--rebuild') {
      parsed.rebuild = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--html') {
      parsed.html = true;
    } else if (arg === '--open') {
      parsed.open = true;
      explicitOpen = true;
    } else if (arg === '--no-open') {
      parsed.noOpen = true;
      explicitNoOpen = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg.startsWith('--filter=')) {
      parsed.filter = arg.slice('--filter='.length);
    } else if (arg.startsWith('--cases-dir=')) {
      parsed.casesDir = resolve(arg.slice('--cases-dir='.length));
    }
  }

  if (explicitNoOpen) {
    parsed.open = false;
  } else if (explicitOpen) {
    parsed.open = true;
  } else if (parsed.json) {
    parsed.open = false;
  } else {
    // Default CLI behavior: auto-open dashboard in browser
    parsed.open = true;
  }

  return parsed;
}

/**
 * Filters overview cases by status string (case-insensitive substring match).
 * @param {object} overviewData
 * @param {string|null} filter
 * @returns {object}
 */
export function applyFilter(overviewData, filter) {
  if (!filter) return overviewData;
  const lowerFilter = filter.toLowerCase();
  const filteredCases = overviewData.cases.filter((c) =>
    (c.status || '').toLowerCase().includes(lowerFilter)
  );
  return {
    ...overviewData,
    cases: filteredCases,
  };
}

// CLI Execution entrypoint
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  try {
    ensureProtocolRegistered({ silent: true });
  } catch {}
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(`
Usage: node .claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs [options]

Options:
  --rebuild           Force full re-scan of case directories and update _overview.json and dashboard.html
  --html              Generate data/cases/dashboard.html
  --open              Explicitly open data/cases/dashboard.html in default web browser (default)
  --no-open           Do not automatically open dashboard in browser
  --json              Emit JSON output to stdout (disables auto-open)
  --filter=<status>   Filter output cases by status (e.g. --filter=open)
  --cases-dir=<dir>   Custom cases directory path
  --help, -h          Show this help message
`);
    process.exit(0);
  }

  const overviewPath = join(options.casesDir, '_overview.json');
  const dashboardPath = join(options.casesDir, 'dashboard.html');
  let overview;

  if (options.rebuild || !existsSync(overviewPath)) {
    overview = buildOverviewData(options.casesDir);
    const tempPath = join(options.casesDir, `_overview.json.tmp.${process.pid}.${Date.now()}`);
    writeFileSync(tempPath, JSON.stringify(overview, null, 2), 'utf8');
    renameSync(tempPath, overviewPath);
  } else {
    try {
      overview = JSON.parse(readFileSync(overviewPath, 'utf8'));
    } catch {
      overview = buildOverviewData(options.casesDir);
      const tempPath = join(options.casesDir, `_overview.json.tmp.${process.pid}.${Date.now()}`);
      writeFileSync(tempPath, JSON.stringify(overview, null, 2), 'utf8');
      renameSync(tempPath, overviewPath);
    }
  }

  // Always keep dashboard.html updated when rebuilding or requesting HTML/Open
  if (options.rebuild || options.html || options.open || !existsSync(dashboardPath)) {
    renderDashboardHtml(overview, dashboardPath);
  }

  if (options.open) {
    openInBrowser(dashboardPath);
  }

  const displayData = applyFilter(overview, options.filter);

  if (options.json) {
    console.log(JSON.stringify(displayData, null, 2));
  } else {
    console.log(renderCliTable(displayData));
  }
}

