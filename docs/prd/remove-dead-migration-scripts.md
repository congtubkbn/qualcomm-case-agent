# PRD: Remove Dead Migration Scripts

## 1. Problem Statement
The codebase contains two obsolete and unused migration scripts that were created during past case schema/metadata migrations:
- `.claude/skills/qualcomm-case-agent/scripts/migrate_case.mjs`
- `.claude/skills/qualcomm-case-agent/scripts/migrate_case_detail.mjs`

These migration scripts have no callers anywhere in the codebase (as confirmed in Research ticket #131) and are safe to delete. Leaving them in the codebase increases maintenance overhead and leads to doc-rot.

## 2. Solution Overview
1. **Delete obsolete scripts and tests**:
   - Delete `.claude/skills/qualcomm-case-agent/scripts/migrate_case.mjs`
   - Delete `.claude/skills/qualcomm-case-agent/scripts/migrate_case_detail.mjs`
   - Delete `tests/migrate_case.test.mjs`
   - Delete `tests/migrate_case_detail.test.mjs`
2. **Clean up downstream test suite**:
   - In [`tests/description_first_comment.test.mjs`](file:///e:/the.thoi/Project/access-qualcomm/tests/description_first_comment.test.mjs), remove imports, constants, and the `describe('5. Cached Case Migration: tools/migrate_case.mjs')` test suite that depends on these deleted migration files.
3. **Regenerate documentation**:
   - Run `npm run docs` to regenerate [`docs/DESIGN.md`](file:///e:/the.thoi/Project/access-qualcomm/docs/DESIGN.md) without references to the deleted migration scripts.

## 3. User Stories (Definition of Done)
- **US1**: The dead migration scripts and their unit tests are deleted from the repository.
- **US2**: The unit/integration test suite passes cleanly via `npm test` after removing references to the migration scripts.
- **US3**: [`docs/DESIGN.md`](file:///e:/the.thoi/Project/access-qualcomm/docs/DESIGN.md) has been regenerated and matches the current codebase exports exactly, passing `npm run docs:check`.

## 4. Deep Modules Map
- [DELETE] `.claude/skills/qualcomm-case-agent/scripts/migrate_case.mjs`
- [DELETE] `.claude/skills/qualcomm-case-agent/scripts/migrate_case_detail.mjs`
- [DELETE] `tests/migrate_case.test.mjs`
- [DELETE] `tests/migrate_case_detail.test.mjs`
- [MODIFY] [`tests/description_first_comment.test.mjs`](file:///e:/the.thoi/Project/access-qualcomm/tests/description_first_comment.test.mjs): Remove references to the deleted migration scripts and test suite.
- [MODIFY] [`docs/DESIGN.md`](file:///e:/the.thoi/Project/access-qualcomm/docs/DESIGN.md): Automatically updated via documentation regeneration script.

## 5. Testing Decisions
- Run `npm test` to ensure all remaining tests pass.
- Run `npm run docs:check` to ensure the generated documentation is in sync.
