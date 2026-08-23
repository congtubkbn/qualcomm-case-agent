---
ID: #63
Status: AFK
Blocked by: []
Type: Tracer Bullet
---

## What to build
Extract and expose case opener / creator metadata (`raisedBy`):
- In `cases_overview.mjs` (`extractCaseOverview`), extract `raisedBy` from `case.json` (`raisedBy`, `creator`, `contactName`, `openedBy` or fallback to `comments[0].author`).
- Include `raisedBy` in the aggregated `_overview.json` data object and terminal CLI summary table.
- Add unit tests in `tests/cases_overview.test.mjs` verifying `raisedBy` extraction.

## Acceptance criteria
- [x] `extractCaseOverview` returns non-empty `raisedBy` for cases with comments or creator fields
- [x] `_overview.json` includes `raisedBy` for all cached cases
- [x] CLI overview table renders `Raised by` column / information
- [x] Unit tests pass cleanly
