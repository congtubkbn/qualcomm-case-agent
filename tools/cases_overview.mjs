// tools/cases_overview.mjs
// Core data scanning and aggregation engine for Qualcomm cases.
// Scans data/cases/<case_number>/ (case.json, summary.json) and maintains data/cases/_overview.json.

import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Discover project data directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_CASES_DIR = resolve(__dirname, '../data/cases');

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

  // Atomic write to _overview.json
  const tempPath = join(casesDir, `_overview.json.tmp.${process.pid}.${Date.now()}`);
  writeFileSync(tempPath, JSON.stringify(overviewData, null, 2), 'utf8');
  renameSync(tempPath, overviewPath);

  return overviewData;
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
    filter: null,
    casesDir: DEFAULT_CASES_DIR,
    help: false,
  };

  for (const arg of args) {
    if (arg === '--rebuild') {
      parsed.rebuild = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg.startsWith('--filter=')) {
      parsed.filter = arg.slice('--filter='.length);
    } else if (arg.startsWith('--cases-dir=')) {
      parsed.casesDir = resolve(arg.slice('--cases-dir='.length));
    }
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
Usage: node tools/cases_overview.mjs [options]

Options:
  --rebuild           Force full re-scan of case directories and update _overview.json
  --json              Emit JSON output to stdout
  --filter=<status>   Filter output cases by status (e.g. --filter=open)
  --cases-dir=<dir>   Custom cases directory path
  --help, -h          Show this help message
`);
    process.exit(0);
  }

  const overviewPath = join(options.casesDir, '_overview.json');
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

  const displayData = applyFilter(overview, options.filter);

  if (options.json) {
    console.log(JSON.stringify(displayData, null, 2));
  } else {
    // Basic terminal output for slice 1
    console.log(`Qualcomm Cases Overview (${displayData.cases.length} cases)`);
    console.log(`Last Updated: ${displayData.stats.lastUpdated}\n`);
    for (const c of displayData.cases) {
      console.log(`[${c.caseNumber}] ${c.title}`);
      console.log(`  Status: ${c.status} | Priority: ${c.priority || 'N/A'} | Comments: ${c.commentCount}`);
      if (c.latestComments && c.latestComments.length > 0) {
        console.log(`  Latest comment: (${c.latestComments[0].author}, ${c.latestComments[0].timestamp}) ${c.latestComments[0].snippet}`);
      }
      console.log('');
    }
  }
}
