---
ID: #65
Status: AFK
Blocked by: [#63, #64]
Type: Polish
---

## What to build
Implement configurable auto-refresh timer (default 5m) and auto-launch dashboard behavior:
- In `dashboard.html`, add auto-refresh timer controls in header:
  - Interval selector: `[Off, 1m, 2m, 5m (default), 10m, 15m]`
  - Live countdown ticker (e.g. "Auto-refresh in: 04:30")
  - Manual "🔄 Refresh Now" button
  - Preserve active filter tab, search query, and hidden states across reloads via `localStorage`.
- Update `cases_overview.mjs` and `SKILL.md` so executing the skill defaults to auto-launching `dashboard.html` in the user's browser.
- Run full test suite (`npm test`) and verify 100% green.

## Acceptance criteria
- [ ] Auto-refresh countdown works with 5m default and configurable intervals
- [ ] Active tab filter and search query survive auto-reload
- [ ] Skill instructions reflect auto-launching behavior
- [ ] 100% tests pass in `npm test`
