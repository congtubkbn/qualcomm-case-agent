// Data/domain module: scans case directories, shapes overview records, computes stats,
// and persists the aggregated _overview.json atomically.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDashboardHtml } from './dashboard_renderer.mjs';

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
export const DEFAULT_CASES_DIR = join(PROJECT_ROOT, 'data', 'cases');

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
