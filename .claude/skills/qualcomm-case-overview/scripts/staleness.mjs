// Shared staleness formatting, used by both the HTML dashboard and CLI table renderers.

/**
 * Formats a human-relative staleness label ("Today", "3 days ago") from a
 * comment timestamp. Returns '' when the timestamp is missing or not
 * Date-parseable (e.g. legacy non-ISO text like "July 22, 2026 at 5:42 AM").
 * @param {string} dateStr
 * @param {Date} [now]
 * @returns {string}
 */
export function formatStaleness(dateStr, now = new Date()) {
  if (!dateStr) return '';
  const parsed = new Date(dateStr);
  if (Number.isNaN(parsed.getTime())) return '';
  const days = Math.floor((now.getTime() - parsed.getTime()) / 86400000);
  if (days < 0) return '';
  if (days === 0) return 'Today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}
