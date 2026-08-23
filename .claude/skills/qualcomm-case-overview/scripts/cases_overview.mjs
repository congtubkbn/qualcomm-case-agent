// Aggregation engine, CLI summary table, and offline HTML dashboard for Qualcomm cases.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
      // In case.json comments are chronological (oldest to newest).
      const newestComment = rawComments[rawComments.length - 1];
      lastCommentAt = newestComment.timestamp || '';
      lastCommentAuthor = newestComment.author || '';

      // Extract up to 3 newest comments (newest first for quick preview)
      const topRecent = rawComments.slice(-3).reverse();
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
      (rawComments.length > 0 && rawComments[0].author ? rawComments[0].author : '');

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

  const cardsHtml = cases.map((c) => {
    const category = getStatusCategory(c.status);
    const badgeClass = `badge-${category}`;
    const escapedCaseNum = escapeHtml(c.caseNumber);
    const escapedTitle = escapeHtml(c.title || 'Untitled Case');
    const escapedStatus = escapeHtml(c.status || 'Unknown');
    const escapedPriority = escapeHtml(c.priority || '');
    const escapedProduct = escapeHtml(c.product || '');
    const escapedAiSummary = escapeHtml(c.aiSummary || '');
    const escapedSyncedAt = escapeHtml(c.syncedAt || '');
    const escapedRaisedBy = escapeHtml(c.raisedBy || '');
    const escapedUrl = escapeHtml(c.url || '');
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

    let priorityBadge = '';
    if (escapedPriority) {
      priorityBadge = `<span class="badge badge-priority">${escapedPriority}</span>`;
    }

    let productBadge = '';
    if (escapedProduct) {
      productBadge = `<span class="badge badge-product">${escapedProduct}</span>`;
    }

    let projectBadge = '';
    const escapedCustomerProject = escapeHtml(c.customerProject || '');
    if (escapedCustomerProject) {
      projectBadge = `<span class="badge badge-project">${escapedCustomerProject}</span>`;
    }

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
        <details class="comments-accordion">
          <summary class="accordion-summary">Recent Updates (${c.latestComments.length})</summary>
          <div class="comments-list">
            ${itemsHtml}
          </div>
        </details>`;
    }

    const caseNumElement = escapedUrl
      ? `<a href="${escapedUrl}" target="_blank" rel="noopener noreferrer" class="case-number" title="Open in Qualcomm Support Portal">#${escapedCaseNum}</a>`
      : `<span class="case-number">#${escapedCaseNum}</span>`;

    const titleElement = escapedUrl
      ? `<h3 class="case-title"><a href="${escapedUrl}" target="_blank" rel="noopener noreferrer" title="Open in Qualcomm Support Portal">${escapedTitle}</a></h3>`
      : `<h3 class="case-title">${escapedTitle}</h3>`;

    return `
      <article class="case-card" data-case-id="${escapedCaseNum}" data-status-category="${category}" data-search="${escapedSearchIndex}">
        <div class="card-top">
          <div class="case-id-group">
            ${caseNumElement}
            <button class="action-btn copy-btn" data-case-id="${escapedCaseNum}" title="Copy Case ID" type="button">Copy ID</button>
            <button class="action-btn hide-btn" data-case-id="${escapedCaseNum}" title="Hide Case from active views" type="button">🚫 Hide</button>
            <button class="action-btn unhide-btn" data-case-id="${escapedCaseNum}" title="Unhide Case to active views" type="button">👁️ Unhide</button>
            <button class="action-btn delete-btn" data-case-id="${escapedCaseNum}" title="Copy a delete instruction for chat" type="button">🗑️ Delete</button>
          </div>
          <div class="card-badges">
            <span class="badge ${badgeClass}">${escapedStatus}</span>
            ${priorityBadge}
            ${productBadge}
            ${projectBadge}
            <span class="badge badge-count">${commentCount} comments</span>
          </div>
        </div>

        ${titleElement}
        ${summaryBlock}

        <div class="meta-row">
          ${escapedRaisedBy ? `<span>Raised by: ${escapedRaisedBy}</span>` : ''}
          ${escapedCustomerProject ? `<span>Project: ${escapedCustomerProject}</span>` : ''}
          ${c.openedAt ? `<span>Opened: ${escapeHtml(c.openedAt)}</span>` : ''}
          ${escapedSyncedAt ? `<span>Synced: ${escapedSyncedAt.slice(0, 10)}</span>` : ''}
          ${c.lastCommentAuthor ? `<span>Latest by: ${escapeHtml(c.lastCommentAuthor)}</span>` : ''}
        </div>

        ${commentsSection}
      </article>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en" data-theme="auto">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Qualcomm Cases Dashboard</title>
  <style>
    :root {
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --text-primary: #0f172a;
      --text-secondary: #475569;
      --text-muted: #94a3b8;
      --border: #e2e8f0;
      --border-subtle: #f8fafc;
      --accent: #2563eb;
      --accent-hover: #1d4ed8;
      --badge-open-bg: #eff6ff;
      --badge-open-text: #1d4ed8;
      --badge-progress-bg: #fffbeb;
      --badge-progress-text: #b45309;
      --badge-closed-bg: #f1f5f9;
      --badge-closed-text: #475569;
      --badge-action-bg: #fef2f2;
      --badge-action-text: #b91c1c;
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
      --border-subtle: #182234;
      --accent: #3b82f6;
      --accent-hover: #60a5fa;
      --badge-open-bg: rgba(59, 130, 246, 0.15);
      --badge-open-text: #93c5fd;
      --badge-progress-bg: rgba(245, 158, 11, 0.15);
      --badge-progress-text: #fcd34d;
      --badge-closed-bg: rgba(148, 163, 184, 0.15);
      --badge-closed-text: #cbd5e1;
      --badge-action-bg: rgba(239, 68, 68, 0.15);
      --badge-action-text: #fca5a5;
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
        --border-subtle: #182234;
        --accent: #3b82f6;
        --accent-hover: #60a5fa;
        --badge-open-bg: rgba(59, 130, 246, 0.15);
        --badge-open-text: #93c5fd;
        --badge-progress-bg: rgba(245, 158, 11, 0.15);
        --badge-progress-text: #fcd34d;
        --badge-closed-bg: rgba(148, 163, 184, 0.15);
        --badge-closed-text: #cbd5e1;
        --badge-action-bg: rgba(239, 68, 68, 0.15);
        --badge-action-text: #fca5a5;
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
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .header-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
    }
    .refresh-controls {
      display: flex;
      align-items: center;
      gap: 8px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      padding: 4px 10px;
      border-radius: var(--radius-sm);
      font-size: 13px;
    }
    .refresh-label {
      color: var(--text-secondary);
      font-weight: 500;
      font-size: 12px;
    }
    .refresh-select {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text-primary);
      padding: 4px 8px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      outline: none;
    }
    .refresh-select:focus {
      border-color: var(--accent);
    }
    .countdown-ticker {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      color: var(--text-muted);
      min-width: 145px;
    }
    .refresh-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-secondary);
      padding: 4px 8px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .refresh-btn:hover {
      background: var(--border-subtle);
      color: var(--text-primary);
      border-color: var(--accent);
    }
    .theme-toggle-btn {
      background: var(--card-bg);
      border: 1px solid var(--border);
      color: var(--text-primary);
      padding: 8px 14px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: all 0.15s ease;
    }
    .theme-toggle-btn:hover {
      border-color: var(--accent);
    }
    .stats-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 20px;
    }
    .stat-pill {
      background: var(--card-bg);
      border: 1px solid var(--border);
      padding: 6px 14px;
      border-radius: 9999px;
      font-size: 13px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
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
      padding: 10px 14px;
      border-radius: var(--radius-md);
      border: 1px solid var(--border);
      background: var(--card-bg);
      color: var(--text-primary);
      font-size: 14px;
      outline: none;
      transition: border-color 0.15s ease;
    }
    .search-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2);
    }
    .filter-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .filter-tab {
      background: var(--card-bg);
      border: 1px solid var(--border);
      color: var(--text-secondary);
      padding: 8px 14px;
      border-radius: var(--radius-md);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .filter-tab:hover {
      border-color: var(--accent);
      color: var(--text-primary);
    }
    .filter-tab.active {
      background: var(--accent);
      color: #ffffff;
      border-color: var(--accent);
    }
    .cases-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 16px;
    }
    .case-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 18px;
      box-shadow: var(--shadow-sm);
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .case-card:hover {
      box-shadow: var(--shadow-md);
    }
    .case-card.hidden {
      display: none !important;
    }
    .card-top {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }
    .case-id-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .case-number {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-weight: 700;
      font-size: 16px;
      color: var(--accent);
      text-decoration: none;
    }
    a.case-number:hover {
      text-decoration: underline;
      color: var(--accent-hover);
    }
    .action-btn, .copy-btn, .hide-btn, .unhide-btn {
      background: transparent;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      padding: 3px 8px;
      font-size: 12px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all 0.15s ease;
    }
    .action-btn:hover, .copy-btn:hover {
      background: var(--border-subtle);
      color: var(--text-primary);
    }
    .copy-btn.copied, .delete-btn.copied {
      background: var(--summary-bg);
      color: var(--summary-text);
      border-color: var(--summary-border);
    }
    .hide-btn:hover {
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
    .card-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
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
    .badge-open { background: var(--badge-open-bg); color: var(--badge-open-text); }
    .badge-in_progress { background: var(--badge-progress-bg); color: var(--badge-progress-text); }
    .badge-closed { background: var(--badge-closed-bg); color: var(--badge-closed-text); }
    .badge-action_required { background: var(--badge-action-bg); color: var(--badge-action-text); }
    .badge-other { background: var(--badge-open-bg); color: var(--badge-open-text); }
    .badge-product { background: var(--border-subtle); color: var(--text-secondary); border: 1px solid var(--border); }
    .badge-project { background: var(--border-subtle); color: var(--text-secondary); border: 1px solid var(--border); }
    .badge-priority { background: var(--border-subtle); color: var(--text-secondary); border: 1px solid var(--border); }
    .badge-count { background: var(--border-subtle); color: var(--text-muted); }
    .case-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 10px;
      word-break: break-word;
    }
    .case-title a {
      color: inherit;
      text-decoration: none;
      transition: color 0.15s ease;
    }
    .case-title a:hover {
      color: var(--accent);
      text-decoration: underline;
    }
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
    .comments-accordion {
      margin-top: 10px;
      border-top: 1px solid var(--border);
      padding-top: 10px;
    }
    .accordion-summary {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-secondary);
      cursor: pointer;
      user-select: none;
      padding: 4px 0;
    }
    .accordion-summary:hover {
      color: var(--accent);
    }
    .comments-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 10px;
      padding-left: 4px;
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
        <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">
          Last updated: ${escapeHtml(stats.lastUpdated || '')}
        </div>
      </div>
      <div class="header-actions">
        <div class="refresh-controls">
          <label for="refreshInterval" class="refresh-label">Auto-refresh:</label>
          <select id="refreshInterval" class="refresh-select" title="Select auto-refresh interval">
            <option value="0">Off</option>
            <option value="60">1m</option>
            <option value="120">2m</option>
            <option value="300" selected>5m (default)</option>
            <option value="600">10m</option>
            <option value="900">15m</option>
          </select>
          <span id="countdownTicker" class="countdown-ticker" title="Time until next auto-refresh">Auto-refresh in: 05:00</span>
          <button id="refreshNowBtn" class="refresh-btn" type="button" title="Refresh dashboard immediately">🔄 Refresh Now</button>
        </div>
        <button id="themeToggle" class="theme-toggle-btn" type="button">🌓 Theme</button>
      </div>
    </header>

    <div class="stats-row">
      <div class="stat-pill">Total: ${stats.total}</div>
      <div class="stat-pill" style="color: var(--badge-open-text);">Open: ${openCount}</div>
      <div class="stat-pill" style="color: var(--badge-progress-text);">In Progress: ${progressCount}</div>
      <div class="stat-pill" style="color: var(--badge-action-text);">Action Required: ${actionCount}</div>
      <div class="stat-pill" style="color: var(--badge-closed-text);">Closed: ${closedCount}</div>
    </div>

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

    <main class="cases-grid">
      ${cardsHtml}
    </main>

    <div id="emptyState" class="empty-state">
      No Qualcomm cases match the selected filter and search criteria.
    </div>
  </div>

  <script>
    document.addEventListener('DOMContentLoaded', () => {
      const searchInput = document.getElementById('searchInput');
      const filterTabs = document.querySelectorAll('.filter-tab');
      const cards = document.querySelectorAll('.case-card');
      const emptyState = document.getElementById('emptyState');
      const themeToggle = document.getElementById('themeToggle');
      const hiddenCountEl = document.getElementById('hiddenCount');
      const refreshSelect = document.getElementById('refreshInterval');
      const countdownTicker = document.getElementById('countdownTicker');
      const refreshNowBtn = document.getElementById('refreshNowBtn');

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

        cards.forEach(card => {
          const cardId = card.getAttribute('data-case-id') || '';
          const cardCategory = card.getAttribute('data-status-category') || '';
          const cardText = (card.getAttribute('data-search') || '').toLowerCase();
          const isHidden = hiddenCases.has(cardId);

          let matchesFilter = false;
          if (currentFilter === 'hidden') {
            matchesFilter = isHidden;
          } else {
            if (isHidden) {
              matchesFilter = false;
            } else {
              matchesFilter = (currentFilter === 'all') || (cardCategory === currentFilter);
            }
          }

          const matchesSearch = !query || cardText.includes(query);

          if (matchesFilter && matchesSearch) {
            card.classList.remove('hidden');
            visibleCount++;
          } else {
            card.classList.add('hidden');
          }
        });

        if (emptyState) {
          if (visibleCount === 0) {
            emptyState.textContent = currentFilter === 'hidden'
              ? 'No hidden cases. Click "Hide" on any case card to move it here.'
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

      // Shared clipboard-copy path (Copy ID, Delete instruction).
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

      function flashCopied(btn, restingText) {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = restingText;
          btn.classList.remove('copied');
        }, 1500);
      }

      // Copy ID buttons
      document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const caseId = btn.getAttribute('data-case-id');
          if (caseId) {
            await copyTextToClipboard(caseId);
            flashCopied(btn, 'Copy ID');
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
            flashCopied(btn, '🗑️ Delete');
          }
        });
      });

      // Theme toggle
      if (themeToggle) {
        const savedTheme = safeStorageGet(STORAGE_KEY_THEME);
        if (savedTheme) {
          document.documentElement.setAttribute('data-theme', savedTheme);
          themeToggle.textContent = savedTheme === 'dark' ? '☀️ Light' : '🌙 Dark';
        }

        themeToggle.addEventListener('click', () => {
          const current = document.documentElement.getAttribute('data-theme');
          let next = 'dark';
          if (current === 'dark') {
            next = 'light';
          } else if (current === 'light') {
            next = 'dark';
          } else {
            const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            next = isDark ? 'light' : 'dark';
          }
          document.documentElement.setAttribute('data-theme', next);
          safeStorageSet(STORAGE_KEY_THEME, next);
          themeToggle.textContent = next === 'dark' ? '☀️ Light' : '🌙 Dark';
        });
      }

      // Auto-refresh countdown timer (default 300s = 5m)
      const savedRefreshInterval = safeStorageGet(STORAGE_KEY_REFRESH);
      let refreshSeconds = savedRefreshInterval !== null ? parseInt(savedRefreshInterval, 10) : 300;
      if (isNaN(refreshSeconds)) refreshSeconds = 300;

      if (refreshSelect) {
        refreshSelect.value = String(refreshSeconds);
      }

      let remainingSeconds = refreshSeconds;
      let refreshTimer = null;

      function formatTime(sec) {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      }

      function updateTickerDisplay() {
        if (!countdownTicker) return;
        if (refreshSeconds <= 0) {
          countdownTicker.textContent = 'Auto-refresh: Off';
        } else {
          countdownTicker.textContent = 'Auto-refresh in: ' + formatTime(remainingSeconds);
        }
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

      if (refreshSelect) {
        refreshSelect.addEventListener('change', (e) => {
          refreshSeconds = parseInt(e.target.value, 10) || 0;
          safeStorageSet(STORAGE_KEY_REFRESH, String(refreshSeconds));
          startCountdown();
        });
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

