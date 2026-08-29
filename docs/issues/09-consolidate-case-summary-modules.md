---
ID: #140
Status: AFK
Blocked by: []
Type: Refactor
---

# 09 (#140): Consolidate qualcomm-case-summary helper modules

## Objective
Consolidate the pure helper functions and effects wrappers from `cap.mjs`, `delta.mjs`, `deps.mjs`, `merge.mjs`, and `render_summary.mjs` directly into `run_summary.mjs` as exports, delete the deprecated source files, and update test suite imports.

## Acceptance Criteria
- [ ] Merge `cap.mjs` into `run_summary.mjs` and export `applyCharCap`, `applyCharCapToComments`.
- [ ] Merge `delta.mjs` into `run_summary.mjs` and export `computeDelta`.
- [ ] Merge `deps.mjs` into `run_summary.mjs` and export `captureCase`.
- [ ] Merge `merge.mjs` into `run_summary.mjs` and export `mergeSummary`.
- [ ] Merge `render_summary.mjs` into `run_summary.mjs` and export `renderSummaryMd`.
- [ ] Delete files:
  - `cap.mjs`
  - `delta.mjs`
  - `deps.mjs`
  - `merge.mjs`
  - `render_summary.mjs`
- [ ] Update imports in test files:
  - `tests/qualcomm_case_summary_cap.test.mjs`
  - `tests/qualcomm_case_summary_delta.test.mjs`
  - `tests/qualcomm_case_summary_merge.test.mjs`
  - `tests/qualcomm_case_summary_render.test.mjs`
  - `tests/qualcomm_case_summary_orchestrator.test.mjs`
  - `tests/qualcomm_case_summary_metadata.test.mjs`
- [ ] Run `npm run docs` to regenerate `docs/DESIGN.md`.
- [ ] Ensure all tests pass (`npm test`).
- [ ] Ensure `npm run docs:check` passes.
