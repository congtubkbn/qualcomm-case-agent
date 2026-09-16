// scripts/finalize_merge.mjs
//
// Comment merge policy: union fresh comments into a cache by content id,
// enforce chronological order, and flag same-author high-similarity "new"
// comments as possible edits of an old one for a human to check.
//
// --merge (update run on an already-cached case): the raw file is a PARTIAL
// capture — only the new posts were expanded; old posts may be collapsed/
// truncated in the DOM. mergeComments keeps every cached comment verbatim,
// prepends only the comments not already cached (dedup by content id), and
// never blanks a cached field from a thinner fresh capture.

import { sortCommentsChronological } from './finalize_normalize.mjs';

// Levenshtein edit distance — used only to compare a handful of same-author
// candidates (see possibleEdits below), never the whole thread.
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}

// 1.0 = identical, 0.0 = nothing in common (normalized edit distance).
function bodySimilarity(a, b) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const x = norm(a), y = norm(b);
  const maxLen = Math.max(x.length, y.length);
  return maxLen === 0 ? 1 : 1 - levenshtein(x, y) / maxLen;
}

// I3: an edit to an old comment's body gives it a new content id (identity is
// content-derived, D19), so it reads as a brand new comment here — silently.
// This does not try to resolve that ambiguity (guessing wrong would silently
// overwrite a different comment's verbatim body, which is worse — D9/V4), it
// only surfaces same-author, high-similarity matches for a human to check.
const POSSIBLE_EDIT_SIMILARITY = 0.55;

// Merge raw comments not already cached and enforce chronological sorting (Oldest -> Newest).
// Cached comments are kept verbatim — an update run never rewrites old bodies.
// Both lists must already carry content ids (see assignIds), so dedup is an id
// lookup rather than a second, separately-drifting heuristic.
export function mergeComments(cachedComments, rawComments, referenceDate = new Date()) {
  const cache = cachedComments || [];
  const have = new Set(cache.map(c => c.id));
  const fresh = [];
  const possibleEdits = [];
  for (const c of rawComments || []) {
    if (have.has(c.id)) continue;
    have.add(c.id);
    fresh.push(c);
    const author = String(c.author || '').trim();
    const candidate = cache
      .filter(o => String(o.author || '').trim() === author)
      .map(o => ({ o, similarity: bodySimilarity(o.body, c.body) }))
      .sort((a, b) => b.similarity - a.similarity)[0];
    if (candidate && candidate.similarity >= POSSIBLE_EDIT_SIMILARITY) {
      possibleEdits.push({ author, oldId: candidate.o.id, newId: c.id });
    }
  }
  const freshChronological = [...fresh].reverse();
  const merged = sortCommentsChronological([...cache, ...freshChronological], referenceDate);
  return { merged, newIds: fresh.map(c => c.id), possibleEdits };
}
