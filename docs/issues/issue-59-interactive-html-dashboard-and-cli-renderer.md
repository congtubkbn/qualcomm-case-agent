---
ID: #59
Status: AFK
Blocked by: [#58]
Type: Tracer Bullet
---

# Issue 59: Interactive HTML Dashboard & CLI Console Renderer

## Parent
PRD: #57 (Multi-Case Overview & Interactive Dashboard for Qualcomm Cases)

## What to build
Implement the interactive single-file HTML Dashboard generator (`renderDashboardHtml`) and the formatted terminal/markdown table renderer (`renderCliTable`) in `tools/cases_overview.mjs`.

## Acceptance criteria
- [ ] Implement `renderDashboardHtml(overviewData)` producing a self-contained HTML file saved to `data/cases/dashboard.html` with zero external CDN dependencies (works 100% offline).
- [ ] Dashboard UI features:
  - Header with total cases and color-coded status badges count.
  - Real-time client-side search across Case ID, title, author, and comment snippets.
  - Status filter tabs (All, Open, In Progress, Closed, Action Required).
  - Prominent Case ID with 1-click "Copy ID" button (no direct broken portal navigation).
  - Expandable accordion previewing top 2-3 recent comments per case.
  - Responsive, modern Dark/Light theme with CSS variables.
- [ ] Implement `renderCliTable(overviewData, options)` rendering a clean table/markdown to stdout for terminal and AI agent consumption.
- [ ] Implement CLI flag `--open` to launch the generated `data/cases/dashboard.html` in the OS default browser.
- [ ] Unit & rendering tests in `tests/cases_overview_render.test.mjs`.

## Blocked by
- #58
