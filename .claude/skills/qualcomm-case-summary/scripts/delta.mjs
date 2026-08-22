// delta.mjs - pure delta computation for qualcomm-case-summary.
// Delta = case comments not yet present in a prior summary.json run, found by
// comment-id set difference (never array position or count). See CONTEXT.md "Delta (comments)".

export function computeDelta(caseComments, summarizedIds) {
  const seen = new Set(summarizedIds);
  return caseComments.filter((c) => !seen.has(c.id));
}
