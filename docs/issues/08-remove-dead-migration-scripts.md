---
ID: #136
Status: AFK
Blocked by: []
Type: Refactor
---

# 08 (#136): Delete migrate_case.mjs and migrate_case_detail.mjs

## Objective
Delete the two dead migration scripts from `scripts/` and their corresponding test files, clean up downstream test references, and regenerate design docs.

## Acceptance Criteria
- [ ] Delete `.claude/skills/qualcomm-case-agent/scripts/migrate_case.mjs`
- [ ] Delete `.claude/skills/qualcomm-case-agent/scripts/migrate_case_detail.mjs`
- [ ] Delete `tests/migrate_case.test.mjs`
- [ ] Delete `tests/migrate_case_detail.test.mjs`
- [ ] Modify `tests/description_first_comment.test.mjs` to remove imports and tests targeting the deleted migration scripts.
- [ ] Run `npm run docs` to regenerate `docs/DESIGN.md`.
- [ ] Ensure `npm test` runs 100% passing.
- [ ] Ensure `npm run docs:check` passes.
