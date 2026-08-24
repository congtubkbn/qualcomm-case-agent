---
ID: #1
Status: AFK
Blocked by: []
Type: Polish
---

# Issue #1: Ensure Qualcomm Case Links Default to Communication Tab

## Description
When clicking Qualcomm case links (`qc://` protocol links, Dashboard links, or global search fallbacks), Chrome should always land on the **Communication** tab (tab #1) rather than the **Detail** tab (tab #2).

## Task Checklist
- [ ] Implement `ensureCommunicationTabUrl(url)` in `scripts/open_qc_case.mjs`.
- [ ] Update `resolveTargetUrl` to run URLs through `ensureCommunicationTabUrl`.
- [ ] Update `scrape_case.mjs` `finalize()` to normalize `url` in `case.json` to tab 1.
- [ ] Update existing `case.json` files (`08623349`, `08642051`) and `_overview.json` to use Communication tab URLs.
- [ ] Add unit tests in `tests/open_qc_case.test.mjs` and `tests/scrape_case.test.mjs`.
- [ ] Run full test suite `npm test` and verify zero failures.
