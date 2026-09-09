// Renders the terminal summary table for Qualcomm case overview data.
import { applyFilter } from './overview_store.mjs';
import { formatStaleness } from './staleness.mjs';

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
    if (c.ballInCourt) metaParts.push(`Pending On: ${c.ballInCourt}`);
    metaParts.push(`Comments: ${c.commentCount || 0}`);

    lines.push(`[${c.caseNumber}] ${c.title || 'Untitled case'}`);
    lines.push(`  ${metaParts.join(' | ')}`);

    const staleness = formatStaleness(c.lastCommentAt);
    if (staleness) {
      lines.push(`  Last activity: ${staleness} (${c.lastCommentAt})`);
    }

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
