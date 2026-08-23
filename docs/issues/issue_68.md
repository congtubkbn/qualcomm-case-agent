---
ID: #68
Status: AFK
Blocked by: []
Type: Tracer Bullet
---

## What to build
Implement Detail tab navigation and field extraction in `qualcomm-case-agent`:
- In `extract_case.js`, enhance layout parser to extract all standard Salesforce Detail fields: `Contact Name`, `Date/Time Opened`, `Date/Time Closed`, `Customer Project`, `Account Name`, `Related CRs`, `Case Record Type Name`, and `Description`.
- In `run_case.mjs`, coordinate switching to the Detail tab to capture metadata, then switching to Feed tab for comments.
- In `scrape_case.mjs`, persist `contactName`, `openedAt`, `closedAt`, `customerProject`, `accountName`, `relatedCRs`, `caseRecordType`, `description` into `case.json`.
- Add unit tests verifying Detail extraction and persistence.

## Acceptance criteria
- [ ] Detail tab fields (`Contact Name`, `Date/Time Opened`, `Customer Project`, etc.) are reliably extracted
- [ ] `case.json` stores `contactName`, `openedAt`, `closedAt`, `customerProject`, etc.
- [ ] Merge and full capture preserves Detail metadata
- [ ] Unit tests pass cleanly
