// render_summary.mjs - pure summary.md renderer for qualcomm-case-summary.
// Presentation-only newest-first order (does not touch case.json/case.md's own
// Oldest -> Newest storage/rendering order in qualcomm-case-agent). See ADR 0002.

function renderComment(c) {
  const lines = [`### ${c.author ?? c.id} (${c.timestamp ?? c.id})`];
  if (c.kind) lines.push(`- Kind: ${c.kind}`);
  if (c.summary) lines.push(`- Summary: ${c.summary}`);
  if (c.impact) lines.push(`- Impact: ${c.impact}`);
  if (c.owner) lines.push(`- Owner: ${c.owner}`);
  if (c.issue) lines.push(`- Issue: ${c.issue}`);
  if (c.status) lines.push(`- Status: ${c.status}`);
  if (c.nextAction) lines.push(`- Next action: ${c.nextAction}`);
  if (c.references?.length) lines.push(`- References: ${c.references.join(', ')}`);
  return lines.join('\n');
}

function renderHeader(summary) {
  const { caseNumber, title, status, priority, product } = summary;
  const caseNum = caseNumber ? String(caseNumber).trim() : '';
  const portalLine = caseNum
    ? `- **Portal**: [Open in Qualcomm Profile (qc://)](qc://case/${caseNum})`
    : '';

  if (!title) return `# Case ${caseNumber} — ${status}`;
  const lines = [`# [${caseNumber}] ${title}`, `- **Status**: ${status}`];
  if (priority) lines.push(`- **Priority**: ${priority}`);
  if (product) lines.push(`- **Product**: ${product}`);
  if (portalLine) lines.push(portalLine);
  return lines.join('\n');
}

function renderExecutiveBlock(executive) {
  if (!executive) return null;
  const lines = ['## Executive Summary', ''];
  if (executive.ballInCourt) {
    const bic = executive.ballInCourt;
    lines.push(`- **Ball in Court**: ${bic.charAt(0).toUpperCase()}${bic.slice(1)}`);
  }
  if (executive.blockerOrNextMilestone) lines.push(`- **Next Milestone**: ${executive.blockerOrNextMilestone}`);
  if (executive.rootCause) lines.push(`- **Root Cause**: ${executive.rootCause}`);
  if (executive.resolution) lines.push(`- **Resolution**: ${executive.resolution}`);
  return lines.join('\n');
}

export function renderSummaryMd(summary) {
  const newestFirst = [...summary.comments].reverse();
  const blocks = [renderHeader(summary)];
  const executiveBlock = renderExecutiveBlock(summary.executive);
  if (executiveBlock) blocks.push(executiveBlock);
  blocks.push(['## Case Flow', '', summary.flow].join('\n'));
  blocks.push(['## Comments (newest first)', '', newestFirst.map(renderComment).join('\n\n'), ''].join('\n'));
  return blocks.join('\n\n');
}
