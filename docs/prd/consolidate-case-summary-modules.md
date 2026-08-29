# PRD: Consolidate Qualcomm Case Summary Modules

## 1. Problem Statement
The downstream case summary engine (`qualcomm-case-summary`) is currently fragmented across 6 tiny files:
- `.claude/skills/qualcomm-case-summary/scripts/run_summary.mjs` (Orchestrator)
- `.claude/skills/qualcomm-case-summary/scripts/cap.mjs` (Character Capping helper)
- `.claude/skills/qualcomm-case-summary/scripts/delta.mjs` (Comment Delta helper)
- `.claude/skills/qualcomm-case-summary/scripts/deps.mjs` (CDP capture effect wrapper)
- `.claude/skills/qualcomm-case-summary/scripts/merge.mjs` (Comment merge helper)
- `.claude/skills/qualcomm-case-summary/scripts/render_summary.mjs` (Markdown renderer helper)

Because these files are so small (ranging from 9 to 118 lines), a developer trying to understand or modify the summary flow has to jump between all of them. This fragmentation violates the principle of **locality** and adds unnecessary complexity for both humans and AI agents.

## 2. Solution Overview
1. **Inline pure logic and wrappers**:
   - Merge the contents of `cap.mjs`, `delta.mjs`, `deps.mjs`, `merge.mjs`, and `render_summary.mjs` directly into `run_summary.mjs`.
   - Export these helper functions from `run_summary.mjs` to keep them fully testable and accessible to existing unit tests.
2. **Delete the consolidated files**:
   - Delete the 5 separate files: `cap.mjs`, `delta.mjs`, `deps.mjs`, `merge.mjs`, and `render_summary.mjs` to eliminate code duplication and maintain single source of truth.
3. **Update the test suite**:
   - Update imports in all corresponding test files under `tests/` (e.g. `tests/qualcomm_case_summary_cap.test.mjs`, etc.) to import from the consolidated `run_summary.mjs` file.
4. **Regenerate documentation**:
   - Run `npm run docs` to regenerate `docs/DESIGN.md` §7 reference section, ensuring the references to the deleted files are removed.

## 3. User Stories (Definition of Done)
- **US1**: All summary helper functions are successfully merged and exported from `run_summary.mjs`.
- **US2**: The original 5 files are deleted from the repository.
- **US3**: The summary unit test files (`qualcomm_case_summary_*.test.mjs`) are updated to import from `run_summary.mjs` and run successfully.
- **US4**: `npm test` runs and all tests pass (100% success).
- **US5**: `npm run docs:check` passes after regenerating the documentation with `npm run docs`.

## 4. Deep Modules Map
- [MODIFY] [`run_summary.mjs`](file:///e:/the.thoi/Project/access-qualcomm/.claude/skills/qualcomm-case-summary/scripts/run_summary.mjs): Absorb and export helpers from `cap.mjs`, `delta.mjs`, `deps.mjs`, `merge.mjs`, and `render_summary.mjs`.
- [DELETE] `cap.mjs` (file:///e:/the.thoi/Project/access-qualcomm/.claude/skills/qualcomm-case-summary/scripts/cap.mjs)
- [DELETE] `delta.mjs` (file:///e:/the.thoi/Project/access-qualcomm/.claude/skills/qualcomm-case-summary/scripts/delta.mjs)
- [DELETE] `deps.mjs` (file:///e:/the.thoi/Project/access-qualcomm/.claude/skills/qualcomm-case-summary/scripts/deps.mjs)
- [DELETE] `merge.mjs` (file:///e:/the.thoi/Project/access-qualcomm/.claude/skills/qualcomm-case-summary/scripts/merge.mjs)
- [DELETE] `render_summary.mjs` (file:///e:/the.thoi/Project/access-qualcomm/.claude/skills/qualcomm-case-summary/scripts/render_summary.mjs)
- [MODIFY] [`tests/qualcomm_case_summary_cap.test.mjs`](file:///e:/the.thoi/Project/access-qualcomm/tests/qualcomm_case_summary_cap.test.mjs): Update imports to target `run_summary.mjs`.
- [MODIFY] [`tests/qualcomm_case_summary_delta.test.mjs`](file:///e:/the.thoi/Project/access-qualcomm/tests/qualcomm_case_summary_delta.test.mjs): Update imports to target `run_summary.mjs`.
- [MODIFY] [`tests/qualcomm_case_summary_merge.test.mjs`](file:///e:/the.thoi/Project/access-qualcomm/tests/qualcomm_case_summary_merge.test.mjs): Update imports to target `run_summary.mjs`.
- [MODIFY] [`tests/qualcomm_case_summary_render.test.mjs`](file:///e:/the.thoi/Project/access-qualcomm/tests/qualcomm_case_summary_render.test.mjs): Update imports to target `run_summary.mjs`.
- [MODIFY] [`tests/qualcomm_case_summary_orchestrator.test.mjs`](file:///e:/the.thoi/Project/access-qualcomm/tests/qualcomm_case_summary_orchestrator.test.mjs): Update imports to target `run_summary.mjs`.
- [MODIFY] [`tests/qualcomm_case_summary_metadata.test.mjs`](file:///e:/the.thoi/Project/access-qualcomm/tests/qualcomm_case_summary_metadata.test.mjs): Update imports to target `run_summary.mjs`.

## 5. Testing Decisions
- Run unit tests via `node --test` for each modified test file.
- Run the full test suite via `npm test`.
- Run the documentation integrity check via `npm run docs:check`.
