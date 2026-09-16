// scripts/finalize_completeness.mjs
//
// Completeness gate policy: fail-closed checks that stop finalize() from
// persisting a capture that is short, still collapsed, or otherwise less
// than the portal actually shows — a failed capture must never look like a
// successful "no update".

import { flattenComments, countAllComments } from './comment_tree.mjs';
import { hasDescriptionComment } from './finalize_description.mjs';

// A post whose "Expand Post" control never got clicked (or got clicked but
// never actually expanded — see run_case.mjs's stuck-loop detection) still
// extracts fine, just with the collapsed teaser text plus the control's own
// label trailing the body (Chatter renders it as a sibling INSIDE the same
// container dom_extractor.js's QC.extractCase() reads). This is root-cause-agnostic: it catches a
// stuck click loop, a selector drift, or any other way a post ends up
// half-captured, by looking at the one thing that's always true of a genuine
// full expansion — the label is gone from the body.
const COLLAPSED_BODY_RE = /\bExpand Post\s*$/i;

// Only check comments NEW to this capture — a --merge (and a full re-capture
// of a cache) deliberately leaves OLD posts collapsed (see dom_extractor.js's QC.expandStep) and
// keeps their cached verbatim bodies, so those legitimately still carry the
// label in the freshly re-extracted DOM. Checking the whole list would reject
// every routine update run.
export function findCollapsed(comments, newIds) {
  const fresh = new Set(newIds);
  // Walk the nested tree (subs:[]) so replies are also checked.
  return flattenComments(comments).filter(c => fresh.has(c.id) && COLLAPSED_BODY_RE.test(c.body));
}

// Completeness gate comparison (Issue #91):
// The Salesforce Chatter badge ("N Chatter Feed Items") counts only top-level posts,
// whereas our Feed extractor captures both top-level posts AND nested replies (e.g. articles inside ul.cuf-replies).
// Therefore:
// 1. capturedCount < displayedCount => under-capture: agent missed items, must fail/retry.
// 2. capturedCount > displayedCount => valid excess due to nested replies; passes with informative warning.
// 3. capturedCount == displayedCount => exact match; passes.
// 4. displayedCount == null => portal badge omitted; persists with warning.
export function countAssert(capturedCount, displayedCount) {
  if (displayedCount == null) {
    return { ok: true, warning: 'displayedCommentCount not provided' };
  }
  if (capturedCount < displayedCount) {
    return { ok: false, captured: capturedCount, displayed: displayedCount };
  }
  if (capturedCount > displayedCount) {
    return {
      ok: true,
      captured: capturedCount,
      displayed: displayedCount,
      warning: `Captured ${capturedCount} comments exceeding displayed badge total of ${displayedCount} (nested replies present)`,
    };
  }
  return { ok: true };
}

// The synthesized description comment is a presentation convenience derived
// from the Case's description field, not a captured Chatter feed item — the
// completeness gate must compare against genuine portal comments only.
// Counts recursively through subs so nested replies are included (the portal's
// displayedCommentCount counts every Chatter post regardless of reply nesting).
export function genuineCommentCount(comments, description) {
  const total = countAllComments(comments);
  const topLevel = Array.isArray(comments) ? comments : [];
  return hasDescriptionComment(topLevel, description) ? total - 1 : total;
}
