---
ID: #64
Status: AFK
Blocked by: [#63]
Type: Tracer Bullet
---

## What to build
Add direct Qualcomm Support Portal navigation and client-side Hide/Unhide capabilities on Dashboard:
- Update `renderDashboardHtml` in `cases_overview.mjs`:
  - Render case title and case number as direct links to `case.url` (`target="_blank"`, `rel="noopener noreferrer"`).
  - Add "Hide" button (👁️ / 🚫) to each case card.
  - Implement `localStorage` state management to store array of hidden case IDs.
  - Add "Hidden Cases (N)" tab in the filter navigation bar.
  - When in "Hidden" view, render "Unhide" button to restore cases back to active views.
- Add unit/DOM verification tests in `tests/cases_overview.test.mjs`.

## Acceptance criteria
- [x] Clicking case title or ID opens `case.url` in new browser tab
- [x] Clicking "Hide" removes case card from active view and persists to `localStorage`
- [x] "Hidden Cases" tab displays hidden cases with working "Unhide" restoration
- [x] Unit tests verify HTML generation contains required attributes and scripts
