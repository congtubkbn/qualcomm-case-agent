---
ID: #54
Status: AFK
Blocked by: [#53]
Type: Tracer Bullet
---

# Issue #54: render_case.mjs: Render Description in Chronological Timeline

## What to build

Update `render_case.mjs` to reflect the unified chronological comment timeline:
1. Remove the standalone `## Description` section from markdown generation to prevent content duplication.
2. Render all comments (including the initial Description comment) in `## Chronological Timeline of Comments`.
3. Verify that `render_summary.mjs` and `qualcomm-case-summary` properly format and display the description comment as part of the case narrative and comment listing.

## Acceptance criteria

- [ ] Standalone `## Description` section is removed from `case.md` rendering.
- [ ] Description comment appears cleanly as Comment #1 in `## Chronological Timeline of Comments`.
- [ ] Summary rendering (`render_summary.mjs`) handles the description comment seamlessly.
- [ ] Existing markdown layout and metadata headers remain intact.

## Blocked by

- [Issue #53](file:///e:/the.thoi/Project/access-qualcomm/docs/issues/issue-53-inject-description-as-initial-comment.md)
