// merge.mjs - pure merge of a new batch of comment summaries into summary.json's shape.
// Prior per-comment summaries are preserved unchanged; the new batch is appended in
// case.json order. Status and flow are replaced with the run's latest values (the flow
// narrative is meant to be updated, not regenerated from scratch, by whoever built `flow`).

export function mergeSummary(prior, { caseNumber, status, newComments, flow, now }) {
  const priorIds = prior?.summarizedCommentIds ?? [];
  const priorComments = prior?.comments ?? [];
  return {
    caseNumber: caseNumber ?? prior?.caseNumber,
    status,
    summarizedCommentIds: [...priorIds, ...newComments.map((c) => c.id)],
    comments: [...priorComments, ...newComments],
    flow,
    lastSummarizedAt: now ?? new Date().toISOString(),
  };
}
