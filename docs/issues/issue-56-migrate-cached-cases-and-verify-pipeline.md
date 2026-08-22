---
ID: #56
Status: AFK
Blocked by: [#54, #55]
Type: Tracer Bullet
---

# Issue #56: migrate_case.mjs: Upgrade Cached Cases and Verify Full Pipeline

## Parent
- PRD: #53

## What to build

Update `tools/migrate_case.mjs` and the test suite:
1. Update `migrateCase()` to inspect `description` in legacy cached cases, converting it into Comment #1 if absent from `comments`, re-sorting chronologically, and updating the file.
2. Add comprehensive automated tests in `tests/description_first_comment.test.mjs` covering:
   - Extraction and ingestion with non-empty description.
   - Dedup and idempotency on `--merge`.
   - Markdown rendering without redundant header.
   - Cached case migration on disk.
3. Run the full project test suite (`npm test`) to ensure zero regressions.

## Acceptance criteria

- [x] `migrateCase()` upgrades legacy `case.json` files correctly.
- [x] Unit and integration tests in `tests/description_first_comment.test.mjs` pass 100%.
- [x] All existing repository tests (`npm test`) remain green.

## Blocked by

- [Issue #54](file:///e:/the.thoi/Project/access-qualcomm/docs/issues/issue-54-inject-description-as-initial-comment.md) (#54)
- [Issue #55](file:///e:/the.thoi/Project/access-qualcomm/docs/issues/issue-55-render-description-in-chronological-timeline.md) (#55)
