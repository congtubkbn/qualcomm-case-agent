---
ID: #5
Status: AFK
Blocked by: []
Type: Refactor
---

# Issue #5: Schema Cleanup - Remove analysisLog & Filter Garbage Timestamps

## Goal
Clean up the raw comment schema in `extract_case.js` and `scrape_case.mjs`:
1. Remove `analysisLog` field from `comments` in `extract_case.js`.
2. Update `computeHash` in `scrape_case.mjs` to no longer require `c.analysisLog`.
3. Filter out Salesforce UI noise in `extractTimestamp` (specifically `"Click for single-item view of this post."`, `"Expand Post"`, `"Chatter Feed Item"`).

## Verification
- Unit test in `tests/extract_case.test.mjs` verifying clean timestamps and absence of `analysisLog`.
- Unit test in `tests/scrape_case.test.mjs` verifying `computeHash` works without `analysisLog`.
