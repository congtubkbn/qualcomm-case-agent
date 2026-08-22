---
ID: #34
Status: AFK
Blocked by: [#33]
Type: Refactor
---

# Issue #34: [Migration Slice 2] CLI & Multi-Case Migration with Index Synchronization

## Goal
Implement CLI execution and file-system integration in `migrate_case.mjs`:
1. Support CLI arguments:
   - `node scripts/migrate_case.mjs <caseNumber>` (single case)
   - `node scripts/migrate_case.mjs all` (all cases in `data/cases/`)
2. For each migrated case:
   - Write updated `case.json`.
   - Update `data/cases/_index.json` entry with new `hash`, `commentCount`, and `syncedAt`.
   - Re-render `case.md` using the rendering logic from `render_case.mjs`.
3. Provide informative console output summarizing migrated cases.

## Verification
- Integration test in `tests/migrate_case.test.mjs` verifying filesystem write, `_index.json` update, and `case.md` generation.
