// Comment identity + hash policy: content-derived comment ids (stable across
// runs regardless of feed position), legacy-id migration, and the case-level
// completeness hash finalize_case.mjs stamps onto every persisted case.json.
//
// COMMENT IDENTITY is content-derived (`commentId` = hash of author + body
// prefix), assigned in finalize() for every persisted comment. Ids used to be
// positional (`c1`, `c2`, … from the extractor), which meant a full re-capture
// of a thread that gained a post re-keyed every comment. Content ids are stable
// across runs and independent of position. A cache still carrying legacy ids is
// migrated on read (`migrateIds`).

import { createHash } from 'node:crypto';
import { flattenComments } from './comment_tree.mjs';

// Hash only the raw, verbatim fields. Stable field order = stable hash across
// runs. `id` is deliberately NOT hashed: it is derived from the author + body that are
// already in here, so hashing it would add nothing but a dependency on the id
// scheme. (Caches written before ids became content-derived therefore re-hash
// once on their next capture — one no-op `updated` verdict, no data change.)
// displayedCommentCount is NOT hashed: it comes from a portal-rendered status
// badge that drifts between reads of an identical thread (observed on 08503838:
// 8 -> 2 with all 11 bodies unchanged), so hashing it turned pure render noise
// into a phantom `updated` verdict carrying newComments: 0. The hash covers
// verbatim comment content only — the thing an "is this case changed?" question
// is actually asking about.
export function computeHash(raw) {
  // Flatten the nested tree (subs:[]) before hashing so the hash covers
  // every comment regardless of nesting level. Flat legacy shape (no subs)
  // also works — flattenComments returns the array unchanged in that case.
  const flatAll = flattenComments(raw.comments);
  const lines = flatAll.map(c =>
    `${c.timestamp || ''}|${c.author || ''}|${c.body || ''}`
  );
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

// Stable identity for dedup across runs. Timestamps are EXCLUDED on purpose:
// Chatter shows relative times ("13h ago") that drift between runs. Author +
// whitespace-normalized body prefix survives both the drift and the collapsed
// (truncated) rendering of old posts in a partial update capture. Known limit:
// an edit inside the first 120 chars of an old comment makes it look new.
export function commentKey(c) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  return `${norm(c.author)}|${norm(c.body).slice(0, 120)}`;
}

// Content-derived comment id: the same comment gets the same id in every run,
// whatever position it now occupies in the feed. This is what makes merge/dedup
// stable across a full re-capture.
export function commentId(c) {
  return `c${createHash('sha256').update(commentKey(c), 'utf8').digest('hex').slice(0, 12)}`;
}

// Assign content ids to a comment list. Two comments with the same key are a
// genuine ambiguity (the same author posting the same opening 120 chars twice),
// so they are kept as distinct comments with a `-N` suffix and REPORTED rather
// than silently collapsed into one.
export function assignIds(comments) {
  const used = new Map();
  const collisions = [];
  const out = (comments || []).map(c => {
    const base = commentId(c);
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    if (n > 1) collisions.push(base);
    return { ...c, id: n === 1 ? base : `${base}-${n}` };
  });
  return { comments: out, collisions };
}

// Bring a cached case written with the old positional ids (c1, c2, …) or with
// raw DOM ids onto content ids. A cache already on content ids, with no legacy
// `enrichment` field, is returned untouched. A legacy `enrichment` field (from
// before this pipeline dropped analysis support) is dropped rather than carried
// forward — nothing produces it any more, so there is nothing to re-key it onto.
export function migrateIds(cached) {
  // A cached case may now carry the nested subs:[] shape — flatten it to a
  // flat list before re-assigning ids, then leave it flat so finalize() can
  // call mergeComments on it directly. The caller (finalize) rebuilds the
  // nested shape at the end via buildNestedTree.
  const before = flattenComments(cached.comments || []);
  const { comments } = assignIds(before);
  const { enrichment, ...rest } = cached;
  return { ...rest, comments };
}
