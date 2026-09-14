// scripts/comment_tree.mjs
//
// Sole owner of the Comment Tree shape: the nested `subs:[]` structure that
// case.json and summary.json both persist (a Comment's replies live in its
// own `subs` array, not a separate structure — see CONTEXT.md's Comment Tree
// entry). Every module that flattens, builds, walks, finds, or clones this
// shape does it through here instead of re-deriving its own traversal.
//
// Two different depth contracts on purpose, not an oversight:
//   - flattenComments/buildNestedTree are hardcoded to ONE level of nesting,
//     because Chatter has no reply-to-reply — a reply's `subs` is always [].
//   - countAllComments/findCommentNode/cloneCommentTree recurse to any depth.
//     They cost nothing extra written that way and were already written that
//     way before this module existed; that generality is not being added
//     speculatively, just kept.
//
// walkCommentTree assumes its input is already a built tree (`subs:[]`
// present) — it does not itself fall back to building one from a flat/parentId
// array. case.json and freshly-written summary.json are nested since #233-236,
// but a still-flat legacy summary.json can reach here as input; reconstructing
// nesting for that case is the caller's job (run_summary.mjs's
// insertCommentsByParent re-derives it via parentIdOf), not this module's.

// Flatten a nested tree (case.json's subs:[] shape) back to a flat array
// with parentId re-attached. Used when loading a cached case.json for merging:
// the merge engine (mergeComments / sortCommentsChronological) always works on
// a flat list, so the tree must be flattened on read and rebuilt on write.
// One level only: a sub's own subs (always []) is discarded.
export function flattenComments(comments) {
  if (!Array.isArray(comments)) return [];
  const out = [];
  for (const c of comments) {
    if (!c || typeof c !== 'object') continue;
    const { subs, ...rest } = c;
    // A top-level comment that never had parentId set (legacy flat shape or
    // new nested shape) comes through as parentId:null.
    out.push({ ...rest, parentId: rest.parentId !== undefined ? rest.parentId : null });
    for (const s of (subs || [])) {
      const { subs: _ss, ...sr } = s;
      out.push({ ...sr, parentId: c.id });
    }
  }
  return out;
}

// Build a nested tree from a flat list that already has parentId set.
// Input: flat array in chronological order (oldest→newest, sortCommentsChronological output).
// Output: top-level comments oldest→newest; each comment has subs:[] (never undefined)
//         holding its replies oldest→newest. parentId is dropped from the output.
// This is the shape written to case.json/summary.json. One level only: Chatter
// has no reply-to-reply, so a leaf's subs is always [].
export function buildNestedTree(comments) {
  if (!Array.isArray(comments) || comments.length === 0) return [];
  const byId = new Map(comments.map(c => [c.id, c]));
  const childrenOf = new Map();
  const topLevel = [];
  for (const c of comments) {
    const parent = c.parentId != null && c.parentId !== c.id ? byId.get(c.parentId) : null;
    if (parent) {
      if (!childrenOf.has(parent.id)) childrenOf.set(parent.id, []);
      childrenOf.get(parent.id).push(c);
    } else {
      topLevel.push(c);
    }
  }
  // topLevel is already chronological (sortCommentsChronological's ascending output).
  return topLevel.map(c => {
    const { parentId, ...rest } = c;
    const kids = (childrenOf.get(c.id) || []).map(k => {
      const { parentId: _p, ...kr } = k;
      // Chatter has no reply-to-reply; leaf subs always carry an empty subs:[].
      return { ...kr, subs: [] };
    });
    return { ...rest, subs: kids };
  });
}

// Count all comments recursively through nested subs.
export function countAllComments(comments) {
  if (!Array.isArray(comments)) return 0;
  return comments.reduce((n, c) => n + 1 + countAllComments(c?.subs), 0);
}

// Depth-first search for the node whose id matches, at any depth. Read-only,
// early-exits on the first match.
export function findCommentNode(nodes, id) {
  for (const n of (nodes || [])) {
    if (n.id === id) return n;
    const found = findCommentNode(n.subs || [], id);
    if (found) return found;
  }
  return null;
}

// Deep-clones a nested tree (any depth), so a caller can mutate the copy
// (e.g. push into a node's subs) without touching the caller's own tree.
export function cloneCommentTree(nodes) {
  return (nodes || []).map((n) => ({ ...n, subs: cloneCommentTree(n.subs) }));
}

/**
 * Walks a nested comment tree (with subs: []) and yields a flat list of comment entries
 * decorated with hierarchical numbers (e.g. "1", "1.1", "1.2", "2", "2.1", etc.).
 *
 * If a visitor callback is provided, it is invoked for each comment: visitor(comment, entry).
 * Returns an array of { comment, number, depth, isReply, parent }.
 */
export function walkCommentTree(comments, visitor, prefix = '', depth = 0, parent = null) {
  if (!Array.isArray(comments)) return [];
  const result = [];
  for (let i = 0; i < comments.length; i++) {
    const c = comments[i];
    if (!c || typeof c !== 'object') continue;
    const num = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
    const entry = {
      comment: c,
      number: num,
      depth,
      isReply: depth > 0 || c.parentId != null,
      parent,
    };
    result.push(entry);
    if (typeof visitor === 'function') {
      visitor(c, entry);
    }
    if (Array.isArray(c.subs) && c.subs.length > 0) {
      result.push(...walkCommentTree(c.subs, visitor, num, depth + 1, c));
    }
  }
  return result;
}
