---
ID: #121
Status: AFK
Blocked by: [#120]
Type: Refactor
---

# 01 (#121): Remove `🔗 Web Link` from Dashboard HTML & Clean Protocol Help Modal

## Objective
Remove the `🔗 Web Link` button from the dashboard card toolbar generator in `cases_overview.mjs` so cards only expose direct `qc://` 1-click on Case ID and Case Title. Clean up the `⚙️ Protocol Help` modal text to remove references to "Web Link fallback".

## Acceptance Criteria
- [ ] No `class="action-btn weblink-btn"` or `🔗 Web Link` rendered in `dashboard.html`.
- [ ] Case ID (`#<caseNumber>`) and Title retain `href="qc://case/<caseNumber>"`.
- [ ] Modal text updated in `dashboard.html` to focus cleanly on `qc://` registration.
- [ ] `tests/cases_overview_render.test.mjs` updated and passing.
