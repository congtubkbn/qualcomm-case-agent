// Status classification shared by dashboard row rendering and page-level counts.

/**
 * Categorizes status for badge colors and filtering. `ballInCourt` (from
 * summary.json's executive.ballInCourt, per #192's rubric: qualcomm | customer |
 * closed | unassigned) takes priority over the status text when present, since
 * it is the authoritative "who needs to act" signal; status-text matching is
 * only a fallback for cases without a summary yet. summary.json is no longer
 * produced (the Summarize workflow was removed, ADR 0007), so `ballInCourt` is
 * always null in practice today and this always falls through to status text.
 * @param {string} status
 * @param {string|null} [ballInCourt]
 * @returns {'open'|'in_progress'|'closed'|'action_required'|'pending_qualcomm'|'pending_customer'|'other'}
 */
export function getStatusCategory(status, ballInCourt) {
  const bic = (ballInCourt || '').toLowerCase();
  if (bic === 'qualcomm') return 'pending_qualcomm';
  if (bic === 'customer') return 'pending_customer';

  if (!status) return 'other';
  const s = status.toLowerCase();
  if (s.includes('action') || s.includes('need info') || s.includes('waiting')) return 'action_required';
  if (s.includes('close')) return 'closed';
  if (s.includes('progress') || s.includes('investigat') || s.includes('fix') || s.includes('pending')) return 'in_progress';
  if (s.includes('open')) return 'open';
  return 'other';
}
