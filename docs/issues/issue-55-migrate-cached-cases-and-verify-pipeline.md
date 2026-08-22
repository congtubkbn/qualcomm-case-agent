---
ID: #55
Status: AFK
Blocked by: [#53, #54]
Type: Tracer Bullet
---

# Issue #55: migrate_case.mjs: Upgrade Cached Cases and Verify Full Pipeline

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

- [ ] `migrateCase()` upgrades legacy `case.json` files correctly.
- [ ] Unit and integration tests in `tests/description_first_comment.test.mjs` pass 100%.
- [ ] All existing repository tests (`npm test`) remain green.

## Blocked by

- [Issue #53](file:///e:/the.thoi/Project/access-qualcomm/docs/issues/issue-53-inject-description-as-initial-comment.md)
- [Issue #54](file:///e:/the.thoi/Project/access-qualcomm/docs/issues/issue-54-render-description-in-chronological-timeline.md)
