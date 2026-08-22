---
ID: #58
Status: AFK
Blocked by: [#57]
Type: Tracer Bullet
---

# Issue 58: Core Aggregation Engine & Schema Management

## Parent
PRD: #57 (Multi-Case Overview & Interactive Dashboard for Qualcomm Cases)

## What to build
Implement the core data scanning and aggregation engine in `tools/cases_overview.mjs` to extract and normalize case metadata from `data/cases/<case_number>/` (`case.json` and `summary.json`) into `data/cases/_overview.json`.

## Acceptance criteria
- [ ] Implement `extractCaseOverview(caseDir, caseNumber)` extracting case number, title, status, priority, product, url, last synced timestamp, AI executive summary (if available), and top 3 newest comments (author, timestamp, snippet).
- [ ] Implement `buildOverviewData(casesDir)` scanning all case directories, aggregating all case records, and computing overview statistics (total count, breakdown by status).
- [ ] Implement `updateCaseOverview(caseNumber, casesDir)` for atomic incremental single-case insertion/update in `data/cases/_overview.json`.
- [ ] Implement CLI flags `--rebuild` (re-scan and overwrite `_overview.json`), `--json` (emit overview JSON to stdout), and `--filter=<status>`.
- [ ] Provide comprehensive unit tests in `tests/cases_overview_data.test.mjs` verifying edge cases (missing fields, no summary, varied comment counts, atomic writes).

## Blocked by
- #57
