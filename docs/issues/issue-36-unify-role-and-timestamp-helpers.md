---
ID: #36
Status: Done
Blocked by: []
Type: Refactor
---

# Issue #36: [Refactor Slice 1] Unify role classification and timestamp sanitization helpers in scrape_case.mjs

## What to build
Consolidate shared extraction and sanitization helpers into `scrape_case.mjs`:
- Export canonical `classifyRole`, `isBlacklistedTs`, and `extractSummary` from `.claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs`.
- Refactor `tools/migrate_case.mjs` to import these utilities directly, eliminating duplicated code.

## Acceptance criteria
- [ ] `classifyRole`, `isBlacklistedTs`, and `extractSummary` are exported from `scrape_case.mjs`
- [ ] `tools/migrate_case.mjs` imports and consumes the canonical helpers
- [ ] Unit tests in `tests/migrate_case.test.mjs` pass cleanly

## Blocked by
- None (can start immediately)
