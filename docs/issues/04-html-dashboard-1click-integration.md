---
Status: AFK
Blocked by: [#100]
Type: Tracer Bullet
---

## Parent
Part of #99

## What to build
Update `cases_overview.mjs` so that clicking `#<caseNumber>` and Case Title anchor tags on the generated `dashboard.html` navigates directly via `qc://case/<caseNumber>`, allowing 1-click access to the case in the authenticated Chrome profile.

1. Update `renderDashboardHtml` in `cases_overview.mjs`:
   - Case number link: `<a href="qc://case/${escapedCaseNum}" class="case-number" title="Open in Qualcomm Profile (qc://)">#${escapedCaseNum}</a>`
   - Case title link: `<a href="qc://case/${escapedCaseNum}" title="Open in Qualcomm Profile (qc://)">${escapedTitle}</a>`
   - Preserve existing action buttons (Copy ID, Hide, Unhide, Delete).
2. Update unit tests in `tests/cases_overview_render.test.mjs` and `tests/cases_overview_e2e.test.mjs` to verify `qc://` links.

## Acceptance criteria
- [ ] Dashboard cards render `qc://case/<caseNumber>` for case number and title links.
- [ ] Tooltip is updated to reflect opening in Qualcomm Profile (`qc://`).
- [ ] Action buttons (Copy ID, Hide, Unhide, Delete) remain fully functional.
- [ ] Unit & render tests in `tests/cases_overview_render.test.mjs` pass.

## Blocked by
- #100
