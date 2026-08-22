// merge.mjs - pure merge of a new batch of comment summaries into summary.json's shape.
// Prior per-comment summaries are preserved unchanged; the new batch is appended in
// case.json order. Status and flow are replaced with the run's latest values (the flow
// narrative is meant to be updated, not regenerated from scratch, by whoever built `flow`).

export function mergeSummary(prior, { caseNumber, title, url, priority, product, status, newComments, flow, executive, now }) {
  const priorIds = prior?.summarizedCommentIds ?? [];
  const priorComments = prior?.comments ?? [];
  // A blank scraped field (e.g. product missing from the case's current view) falls back to
  // the prior known value instead of blanking it out; "" is treated as absent, not a real update.
  const mergedTitle = title || prior?.title;
  const mergedUrl = url || prior?.url;
  const mergedPriority = priority || prior?.priority;
  const mergedProduct = product || prior?.product;
  const mergedExecutive = executive ?? prior?.executive;
  return {
    caseNumber: caseNumber ?? prior?.caseNumber,
    ...(mergedTitle && { title: mergedTitle }),
    ...(mergedUrl && { url: mergedUrl }),
    ...(mergedPriority && { priority: mergedPriority }),
    ...(mergedProduct && { product: mergedProduct }),
    status,
    ...(mergedExecutive && { executive: mergedExecutive }),
    summarizedCommentIds: [...priorIds, ...newComments.map((c) => c.id)],
    comments: [...priorComments, ...newComments],
    flow,
    lastSummarizedAt: now ?? new Date().toISOString(),
  };
}
