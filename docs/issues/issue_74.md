---
ID: #74
Status: AFK
Blocked by: [#72, #73]
Type: Tracer Bullet
---

## What to build
- Run full end-to-end extraction against live Case `08316063`:
  - `node .claude/skills/qualcomm-case-agent/scripts/run_case.mjs 08316063`
  - `node .claude/skills/qualcomm-case-summary/scripts/run_summary.mjs prepare 08316063`
- Verify that `data/cases/08316063/case.json` and `case.md` contain clean comments, non-empty description, and accurate detail metadata.
- Execute full test suite `npm test` and verify zero regressions.

## Acceptance criteria
- [ ] Case `08316063` capture completes with `status: ok` / `status: no-update` without getting blocked
- [ ] `description` is non-empty and accurately reflects the problem statement
- [ ] No comments contain trailing `"Expand Post"` text
- [ ] Full test suite `npm test` passes 100%
