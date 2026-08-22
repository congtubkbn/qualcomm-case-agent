---
ID: #7
Status: Done
Blocked by: [#5, #6]
Type: Polish
---

# Issue #7: Update Markdown Renderer & Suite-wide Test Alignment

## Goal
1. Update `render_case.mjs` to optionally display comment `summary` and remove obsolete `analysisLog` code block formatting.
2. Run full regression test suite via `npm test` and verify that all mocks and assertions match the updated schema.

## Verification
- `npm test` passes 100% cleanly.
- `node render_case.mjs data/cases/08637663/case.json` outputs valid Markdown without errors.
