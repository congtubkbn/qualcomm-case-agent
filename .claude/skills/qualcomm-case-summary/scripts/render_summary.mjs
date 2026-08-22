// render_summary.mjs - pure summary.md renderer for qualcomm-case-summary.
// Presentation-only newest-first order (does not touch case.json/case.md's own
// Oldest -> Newest storage/rendering order in qualcomm-case-agent). See ADR 0002.

function renderComment(c) {
  const lines = [`### ${c.author ?? c.id} (${c.timestamp ?? c.id})`];
  if (c.issue) lines.push(`- Issue: ${c.issue}`);
  if (c.status) lines.push(`- Status: ${c.status}`);
  if (c.nextAction) lines.push(`- Next action: ${c.nextAction}`);
  return lines.join('\n');
}

export function renderSummaryMd(summary) {
  const newestFirst = [...summary.comments].reverse();
  return [
    `# Case ${summary.caseNumber} — ${summary.status}`,
    '',
    '## Case Flow',
    '',
    summary.flow,
    '',
    '## Comments (newest first)',
    '',
    newestFirst.map(renderComment).join('\n\n'),
    '',
  ].join('\n');
}
