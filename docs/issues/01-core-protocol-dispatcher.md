---
Status: AFK
Blocked by: []
Type: Tracer Bullet
---

## Parent
Part of #99

## What to build
Build the core `qc://` protocol dispatcher script (`scripts/open_qc_case.mjs`).
When invoked with a URI like `qc://case/08603854` or `qc://08603854` or `qc://open?url=...`:
1. Parses and validates the URI.
2. Resolves the target Qualcomm Case URL (reads local `data/cases/<caseNumber>/case.json` for the exact Salesforce URL, or falls back to `https://support.qualcomm.com/s/global-search/<caseNumber>`).
3. Connects to CDP port 9773 on `127.0.0.1`:
   - If active, creates/navigates a tab directly via CDP.
   - If not active, launches Chrome via `connect_chrome.ps1` with the target URL and `--user-data-dir="data/chrome-profile"`.
4. Comprehensive test suite in `tests/open_qc_case.test.mjs` with mocked CDP HTTP and process invocation.

## Acceptance criteria
- [ ] Correctly parses `qc://case/08603854`, `qc://08603854`, and `qc://open?url=...` URIs.
- [ ] Reads `case.json` if available to get the direct portal URL; falls back cleanly to search URL.
- [ ] CDP navigation opens new tab seamlessly if Chrome is already running.
- [ ] Gracefully invokes `connect_chrome.ps1` if Chrome is closed.
- [ ] 100% passes `tests/open_qc_case.test.mjs` without opening real browser windows during tests.

## Blocked by
None (can start immediately)
