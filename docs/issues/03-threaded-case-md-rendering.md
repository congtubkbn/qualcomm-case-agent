---
ID: #114
Status: AFK
Blocked by: [#113]
Type: Tracer Bullet
---

## Parent
Part of #105 — spec: `docs/prd/case-detail-and-threaded-comments.md`

## What to build
Fold the prototyped Variant A layout (decided in #109) into `render_case.mjs`'s real Chronological
Timeline rendering loop, using the `parentId` field landed by
[`02-comment-threading.md`](02-comment-threading.md).

1. In the comment-rendering loop, for a comment where `parentId != null`:
   - Prefix the heading with `↳`.
   - Render the comment body as a Markdown blockquote (`> ` per line) instead of plain paragraph
     text.
2. Numbering stays strict chronological (`1..N`, `sortCommentsChronological`'s existing order) —
   this is a presentation-only change, no renumbering by thread.
3. Reference the throwaway prototype for the exact Variant A formatting:
   `.claude/skills/qualcomm-case-agent/scripts/render_case.prototype-109.mjs` on branch
   `prototype/109-reply-layouts` (not merged — read for the formatting approach, don't merge the
   branch itself).

## Acceptance criteria
- [ ] Case 08633581's regenerated `case.md` shows comment 1 as a plain `###` heading and comments
      2-4 with `↳`-prefixed headings and blockquoted bodies.
- [ ] Numbering in the rendered `case.md` stays `1, 2, 3, 4` regardless of nesting — no thread-local
      renumbering.
- [ ] A top-level Post with zero replies renders identically to today's output (no regression for
      the common case).

## Blocked by
[`02-comment-threading.md`](02-comment-threading.md) — needs `parentId` in `case.json` first.
