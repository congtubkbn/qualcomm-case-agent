// Data/domain module: scans case directories, shapes overview records, computes stats,
// and persists the aggregated _overview.json atomically.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DATA_DIR } from './_paths.mjs';
import { renderDashboardHtml } from './dashboard_renderer.mjs';
import { acquireOverviewLock, releaseOverviewLock, withOverviewLock } from './overview_lock.mjs';

export { acquireOverviewLock, releaseOverviewLock };

export const DEFAULT_CASES_DIR = DATA_DIR;

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
      // In case.json comments are newest-first (see finalize_case.mjs's
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
    let ballInCourt = null;

    if (existsSync(summaryJsonPath)) {
      try {
        const summaryRaw = readFileSync(summaryJsonPath, 'utf8');
        const summaryJson = JSON.parse(summaryRaw);
        aiSummary = extractAiSummary(summaryJson);
        ballInCourt = (summaryJson.executive && typeof summaryJson.executive.ballInCourt === 'string')
          ? summaryJson.executive.ballInCourt
          : null;
        hasSummary = true;
      } catch {
        hasSummary = false;
        aiSummary = null;
        ballInCourt = null;
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
      ballInCourt,
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
 * Unified, resilient synchronization seam for case overview cache and dashboard.
 * Supports both upserting and removing cases from the overview cache,
 * atomically persisting _overview.json, recomputing summary statistics,
 * and regenerating dashboard.html.
 *
 * @param {string} caseNumber
 * @param {object|string} [options={}] Options object, or dataDir string for backward compatibility
 * @param {'upsert'|'remove'} [options.action='upsert'] Sync action
 * @param {string} [options.casesDir=DEFAULT_CASES_DIR] Directory containing cases
 * @param {string} [options.dataDir] Alias for casesDir
 * @param {boolean} [options.render=true] Whether to regenerate dashboard.html
 * @param {function} [options.renderDashboard=renderDashboardHtml] Injectable dashboard renderer
 * @param {function} [options.onError] Optional error callback (err, stage)
 * @returns {{ hadEntry: boolean, overviewData: object, rendered: boolean }}
 */
export function syncCaseOverview(caseNumber, options = {}) {
  const opts = typeof options === 'string' ? { casesDir: options } : (options || {});
  const {
    action = 'upsert',
    render = true,
    renderDashboard = renderDashboardHtml,
    onError,
  } = opts;
  const casesDir = opts.casesDir || opts.dataDir || DEFAULT_CASES_DIR;

  const overviewPath = join(casesDir, '_overview.json');
  if (!existsSync(casesDir)) {
    mkdirSync(casesDir, { recursive: true });
  }

  let overviewData;
  let hadEntry = false;

  // Lock the read-modify-write-rename below via overview_lock module: two
  // syncCaseOverview calls racing on the SAME _overview.json — e.g. finalize_case.mjs
  // and run_summary.mjs finishing for two different cases at once (issue #202) — can't
  // both "win" the read-modify-write and clobber each other's upsert.
  const syncResult = withOverviewLock(casesDir, () => {
    if (existsSync(overviewPath)) {
      try {
        overviewData = JSON.parse(readFileSync(overviewPath, 'utf8'));
        if (overviewData && Array.isArray(overviewData.cases)) {
          hadEntry = overviewData.cases.some((c) => c.caseNumber === caseNumber);
        } else {
          overviewData = buildOverviewData(casesDir);
        }
      } catch {
        overviewData = buildOverviewData(casesDir);
      }
    } else {
      overviewData = action === 'remove'
        ? { cases: [], stats: { total: 0, byStatus: {}, lastUpdated: new Date().toISOString() } }
        : buildOverviewData(casesDir);
    }

    if (action === 'remove') {
      if (!hadEntry) {
        return { earlyExit: true, hadEntry: false, overviewData };
      }
      overviewData.cases = overviewData.cases.filter((c) => c.caseNumber !== caseNumber);
    } else {
      // action === 'upsert'
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
    }

    // Re-sort and recompute stats
    overviewData.cases.sort((a, b) => {
      if (a.syncedAt && b.syncedAt) {
        return b.syncedAt.localeCompare(a.syncedAt);
      }
      return b.caseNumber.localeCompare(a.caseNumber);
    });

    overviewData.stats = computeStats(overviewData.cases);

    // Atomic write to _overview.json
    const tempPath = join(casesDir, `_overview.json.tmp.${process.pid}.${Date.now()}`);
    writeFileSync(tempPath, JSON.stringify(overviewData, null, 2), 'utf8');
    renameSync(tempPath, overviewPath);

    return { earlyExit: false, hadEntry, overviewData };
  });

  if (syncResult.earlyExit) {
    return { hadEntry: false, overviewData: syncResult.overviewData, rendered: false };
  }
  overviewData = syncResult.overviewData;
  hadEntry = syncResult.hadEntry;

  let rendered = false;
  if (render) {
    const dashboardPath = join(casesDir, 'dashboard.html');
    try {
      renderDashboard(overviewData, dashboardPath);
      rendered = true;
    } catch (e) {
      rendered = false;
      if (typeof onError === 'function') {
        onError(e, 'render');
      }
      process.stderr.write(`Warning: dashboard render failed (${e.message})\n`);
    }
  }

  return { hadEntry, overviewData, rendered };
}

/**
 * Incrementally updates or inserts a single case record in _overview.json atomically.
 * Backwards-compatible wrapper delegating to syncCaseOverview with render: false.
 * @param {string} caseNumber Case ID (e.g. "08603854")
 * @param {string} casesDir Directory containing case folders
 * @returns {object} The updated overview data
 */
export function updateCaseOverview(caseNumber, casesDir = DEFAULT_CASES_DIR) {
  const result = syncCaseOverview(caseNumber, {
    action: 'upsert',
    casesDir,
    render: false,
  });
  return result.overviewData;
}

/**
 * Resilient synchronization hook for a finalized case (capture or summary).
 * Convenience wrapper around syncCaseOverview that never throws and isolates errors.
 * @param {string} caseCode Case number
 * @param {string} dataDir Directory containing cases
 * @param {object} [options={}] Configuration options
 * @returns {{ hadEntry: boolean, overviewData: object|null, rendered: boolean }}
 */
export function afterFinalize(caseCode, dataDir, options = {}) {
  const syncFn = options.syncCaseOverview || syncCaseOverview;
  try {
    if (typeof options.updateCaseOverview === 'function') {
      options.updateCaseOverview(caseCode, dataDir);
    }
    return syncFn(caseCode, {
      ...options,
      casesDir: dataDir,
      action: 'upsert',
    });
  } catch (e) {
    if (typeof options.onError === 'function') {
      options.onError(e, 'overview');
    }
    process.stderr.write(`Warning: overview auto-sync failed (${e.message})\n`);
    return { hadEntry: false, overviewData: null, rendered: false };
  }
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
