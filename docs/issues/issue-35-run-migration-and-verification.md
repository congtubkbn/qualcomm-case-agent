---
ID: #35
Status: Done
Blocked by: [#33, #34]
Type: Polish
---

# Issue #35: [Migration Slice 3] Migrate Existing Cached Cases & Full Verification

## Goal
1. Execute `migrate_case.mjs` against existing cached cases in `data/cases/` (specifically case `08637663`).
2. Verify `data/cases/08637663/case.json`, `data/cases/08637663/case.md`, and `data/cases/_index.json` conform to the optimized schema.
3. Run `npm test` and `verify_case.mjs` to ensure 100% test pass rate and zero schema regressions.

## Verification
- `data/cases/08637663/case.json` has clean timestamps, summaries, and no `analysisLog`.
- `npm test` passes cleanly (100% pass).
- `node .claude/skills/qualcomm-case-agent/scripts/verify_case.mjs 08637663` passes with exit code 0.
