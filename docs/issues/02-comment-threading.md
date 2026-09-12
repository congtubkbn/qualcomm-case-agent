---
ID: #113
Status: AFK
Blocked by: []
Type: Tracer Bullet
---

> **Superseded 2026-09 (#233/#234/#235, closed out by #236).** The shipped shape is a nested
> `subs: []` tree, not a flat `parentId` field: each top-level Comment carries `subs: []` holding
> its replies (oldest→newest; Chatter has no reply-to-reply, so `subs` is single-level and each
> reply's own `subs` is always `[]`). `parentId` is a transient merge-time field only —
> `finalize_case.mjs`'s `buildNestedTree()` resolves it into tree position and then strips it, so it
> never appears in persisted `case.json`. `depth` is still not persisted; a reader derives it from
> tree position (`0` for a top-level Comment, `1` for anything inside a `subs` array). Both
> `case.json` and `case.md` order oldest-first at every level — this also supersedes ADR 0002's
> newest-first presentation decision (see `docs/prd/case-detail-and-threaded-comments.md`'s own
> superseded note). The `parentId`-based description below is the original (unbuilt) design; read it
> for the DOM-derivation algorithm, which is still accurate, not for the final persisted shape.

## Parent
Part of #105 — spec: `docs/prd/case-detail-and-threaded-comments.md`

## What to build (original design — superseded, see note above)
Add `parentId: string | null` to each Comment in `case.json`'s `comments` array — `null` for a
top-level Post, the parent Post's content-hash `id` for a Reply. No `depth` field is persisted (it's
always derivable as `parentId ? 1 : 0`). Algorithm and id-timing constraint per #106.

1. `extract_case.js`, inside the existing `qsa("article").map(...)` comment-walk loop (~L331-364):
   track `lastTopLevelIndex` as the loop walks in DOM order. Emit `parentIndex` per comment (a
   run-scoped array-index proxy, not a final id) — `null` for a non-reply `<article>`, the current
   `lastTopLevelIndex` for a reply. **Must be computed against the pre-filter array** — the trailing
   `.filter(c => c.body.length > 0)` runs after the map, so if it drops any comment, `parentIndex`
   values need to either be resolved before the filter or rewritten to post-filter positions.
2. `scrape_case.mjs`, immediately after `assignIds()` (existing call, ~L746) and **before**
   `mergeComments`/`sortCommentsChronological` (~L755/L780) — while the array is still in DOM order:
   resolve each comment's `parentIndex` into the *new* content-hash `id` of the comment at that
   array index. `parentId: (c.parentIndex != null && fresh.comments[c.parentIndex]) ?
   fresh.comments[c.parentIndex].id : null`.
3. `scrape_case.mjs`'s `finalize()` comment-strip destructure (~L862, `{ role, company,
   displayPosition, isReply, ...rest }`): add `parentIndex` to the strip list (it's a transient
   proxy, never persisted); leave `parentId` OUT of the strip list — it's the field being kept.
4. This must work correctly on incremental `--merge` runs: `extract_case.js` re-walks the full
   current DOM every run (old + new articles), so an old cached parent Post's id gets recomputed
   identically (same author+body → same hash); `mergeComments`'s dedup then drops the re-seen old
   Post from the fresh batch while the cached copy (already carrying its own previously-resolved
   `parentId`) is kept verbatim — a new Reply's freshly-resolved `parentId` still points at the
   correct stable id even though the parent Post itself wasn't "new" this run. Verify this with a
   test that simulates a 2-phase capture (Post captured first, Reply added on a later `--merge`).

## Acceptance criteria
- [ ] Case 08633581 (real 1-post-3-reply data used in #106's verification) produces
      `parentId: null` for the post and `parentId: <post's id>` for all 3 replies.
- [ ] A synthetic multi-post case (2+ top-level Posts, each with replies) never has a Reply's
      `parentId` resolve to the wrong Post.
- [ ] An incremental `--merge` run where a Reply is added after its parent Post was already cached
      resolves `parentId` correctly (the 2-phase-capture test above).
- [ ] `parentIndex` and `isReply` never appear in persisted `case.json`.
- [ ] `sortCommentsChronological`'s existing ordering behavior is unchanged — this ticket adds a
      field, it does not touch sort logic.

## Blocked by
None (independent of `01-case-level-field-schema` — different files/fields; can land in parallel or
either order)
