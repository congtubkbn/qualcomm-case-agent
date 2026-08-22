---
ID: #62
Status: AFK
Blocked by: [#61]
Type: Refactor
---

# Standardize qualcomm-case-overview Skill Structure

## Description
Move `tools/cases_overview.mjs` into `.claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs` to conform to the standard deep skill layout used across the repository.

## Tasks
1. Move `tools/cases_overview.mjs` -> `.claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs`.
2. Clean up redundant `.agents/skills/qualcomm-case-overview/` directory.
3. Update `.claude/skills/qualcomm-case-overview/SKILL.md` to reference `.claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs`.
4. Update `package.json` scripts (`cases:overview`, `cases:dashboard`).
5. Update `tools/gen_design.mjs` to scan `.claude/skills/qualcomm-case-overview/scripts`.
6. Update imports and assertions in `tests/cases_overview_data.test.mjs`, `tests/cases_overview_render.test.mjs`, `tests/cases_overview_e2e.test.mjs`.
7. Run `npm test` and `npm run docs` to verify 100% green tests and synchronized design docs.
