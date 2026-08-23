# PRD: Qualcomm Case Detail Tab Extraction & Accurate Metadata Alignment

## Problem Statement
Currently, `qualcomm-case-agent` extracts case data exclusively from the Salesforce **Feed** tab. Because the Feed view only renders Chatter posts, critical case-level metadata residing in the **Detail** tab—such as `Contact Name` (the actual person who raised the case), `Date/Time Opened`, `Date/Time Closed`, `Customer Project`, `Account Name`, `Related CRs`, and `Description`—are either left blank or inaccurately inferred (e.g., `raisedBy` falling back to the author of the first comment, who may be a responding engineer rather than the original requester).

## Solution
1. **Detail Tab DOM Extractor & Navigation**:
   - Add automated tab navigation in `run_case.mjs` / `browser.mjs` to switch to the Salesforce **Detail** tab (e.g. `[role="tab"][title="Detail"]` or `tabset...=2`) before/after the Feed extraction.
   - In `extract_case.js`, accurately parse and map all fields from the Detail layout:
     - `Contact Name` -> `contactName` (and `raisedBy`)
     - `Date/Time Opened` -> `openedAt` / `created`
     - `Date/Time Closed` -> `closedAt`
     - `Customer Project` -> `customerProject`
     - `Account Name` -> `accountName` / `customer`
     - `Related CRs` -> `relatedCRs`
     - `Case Record Type Name` -> `caseRecordType`
     - `Description Information / Description` -> `description`
     - `Status` and `Priority`
2. **Schema & Downstream Integration**:
   - Standardize `case.json` to persist all extracted Detail fields.
   - Update `qualcomm-case-overview` (`cases_overview.mjs`) to strictly prioritize `caseJson.contactName` / `caseJson.raisedBy` for case opener display, and display `customerProject` and `openedAt` in CLI tables and HTML Dashboard.
   - Update Markdown renderer (`render_case.mjs`) to render Case Details metadata clearly.
3. **Migration & Backward Compatibility**:
   - Ensure existing cached cases without Detail fields continue to operate safely.
   - Provide utilities to refresh / re-sync cached cases with full Detail metadata.

## User Stories & Definition of Done (DoD)
- **US1 (Detail Extraction)**: When capturing a Qualcomm case, the pipeline automatically navigates to the Detail tab, extracts `Contact Name`, `Date/Time Opened`, `Date/Time Closed`, `Customer Project`, `Account Name`, `Related CRs`, `Description`, and merges them with Feed comments.
- **US2 (Accurate Case Opener)**: In `cases_overview.mjs`, CLI summary, and Dashboard, the case opener is accurately attributed to `Contact Name` (e.g. `Mai Ngoc`), not the first comment author.
- **US3 (Dashboard & Markdown Rich View)**: Case markdown (`case.md`) and HTML Dashboard show the project (`Customer Project`), accurate open date (`Date/Time Opened`), and contact name.
- **US4 (Robust Test Coverage)**: Unit tests verify Detail DOM parsing, schema normalization, and overview updates without regressions.

## Deep Modules Map
- `qualcomm-case-agent/scripts/extract_case.js`: Add robust extraction selectors for Detail tab fields.
- `qualcomm-case-agent/scripts/run_case.mjs`: Coordinate Detail tab navigation and Feed expansion.
- `qualcomm-case-agent/scripts/scrape_case.mjs`: Persist Detail fields into `case.json`.
- `qualcomm-case-agent/scripts/render_case.mjs`: Render Detail metadata in `case.md`.
- `qualcomm-case-overview/scripts/cases_overview.mjs`: Prioritize `contactName` and expose project metadata.
- `tests/`: Add unit tests for Detail field extraction and overview aggregation.

## Testing Strategy
- Unit tests for `extract_case.js` and Detail layout field parsing.
- Unit tests for `scrape_case.mjs` ensuring Detail fields are preserved during full and merge captures.
- Unit tests for `cases_overview.mjs` ensuring `raisedBy` and `customerProject` are correctly surfaced.
