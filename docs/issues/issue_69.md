---
ID: #69
Status: AFK
Blocked by: [#68]
Type: Tracer Bullet
---

## What to build
Integrate Detail tab metadata across downstream components (Overview, Dashboard, Markdown):
- In `qualcomm-case-overview/scripts/cases_overview.mjs`, prioritize `caseJson.contactName` / `caseJson.raisedBy` for `raisedBy`.
- Expose `customerProject` and `openedAt` in case records, terminal CLI summary table, and HTML Dashboard (`dashboard.html`).
- In `qualcomm-case-agent/scripts/render_case.mjs`, update `case.md` rendering to display Detail metadata (`Contact Name`, `Customer Project`, `Opened Date`, etc.).
- Add unit tests verifying `raisedBy` and `customerProject` rendering in overview and dashboard.

## Acceptance criteria
- [ ] `raisedBy` strictly reflects `contactName` from Detail tab
- [ ] Dashboard and CLI table display `Customer Project` and accurate opened timestamp
- [ ] `case.md` renders Case Information block with Contact Name, Customer Project, Date Opened
- [ ] Unit tests pass cleanly
