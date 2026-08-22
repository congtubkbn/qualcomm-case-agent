---
ID: #60
Status: AFK
Blocked by: [#59]
Type: Tracer Bullet
---

# Issue 60: Skill Registration, Auto-Sync Hooks & Full Pipeline Verification

## Parent
PRD: #57 (Multi-Case Overview & Interactive Dashboard for Qualcomm Cases)

## What to build
Register the `qualcomm-case-overview` skill for AI agents, wire npm run scripts in `package.json`, connect auto-sync hooks to keep `_overview.json` fresh after captures/summaries, and verify the entire end-to-end workflow.

## Acceptance criteria
- [ ] Add `cases:overview` and `cases:dashboard` scripts to `package.json`.
- [ ] Create skill definition in `.claude/skills/qualcomm-case-overview/SKILL.md` (and `.agents/skills/qualcomm-case-overview/SKILL.md`).
- [ ] Integrate incremental update hook into `qualcomm-case-agent` and `qualcomm-case-summary` completion handlers.
- [ ] Write end-to-end integration test `tests/cases_overview_e2e.test.mjs`.
- [ ] Update `README.md` and regenerate documentation with `npm run docs`.

## Blocked by
- #59
