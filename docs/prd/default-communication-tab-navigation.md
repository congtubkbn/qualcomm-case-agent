# PRD: Default Qualcomm Case Navigation to Communication Tab

## 1. Problem Statement
Currently, when a Qualcomm case is scraped or updated by the browser agent, the scraper clicks on the **Detail** tab to extract case metadata (e.g. `contactName`, `customerProject`, `openedAt`, `accountName`). In Salesforce Community, clicking the Detail tab appends `?tabset-<id>=2` to the page URL in the browser's address bar.
When this URL is saved to `case.json` or resolved by `open_qc_case.mjs` when clicking `#caseNumber` or links on the Dashboard (`qc://case/...`), Chrome opens the case directly on tab #2 (**Detail**). Users want clicks on case links to always open tab #1 (**Communication**) by default.

## 2. Solution Overview
1. **URL Normalization in Protocol Dispatcher (`scripts/open_qc_case.mjs`)**:
   - Create `ensureCommunicationTabUrl(url)` helper that rewrites any `tabset-([a-zA-Z0-9_-]+)=\d+` query parameter from `=2` (or any other index) to `=1` (Communication tab).
   - Ensure `resolveTargetUrl(parsed, options)` and direct `qc://open?url=...` calls pass target URLs through `ensureCommunicationTabUrl` before launching or dispatching via CDP.
2. **Data Layer Normalization (`scrape_case.mjs`)**:
   - In `finalize()`, normalize `raw.url` to ensure saved URLs in `case.json` carry `tabset-XXXX=1` (or clean URLs pointing to Communication tab).
3. **Data Sanitization for Existing Cases**:
   - Update existing `case.json` files and `_overview.json` so existing saved URLs use `tabset-XXXX=1`.

## 3. User Stories (Definition of Done)
- **US1**: As a user clicking any case ID `#08623349` or Qualcomm link on the Dashboard or in Markdown docs, the launched Chrome window must open to the **Communication** tab on Salesforce support.
- **US2**: As a user running `open_qc_case.mjs "qc://case/08623349"`, the dispatched URL must use `tabset-8baba=1` (or equivalent Communication tab param) instead of `tabset-8baba=2`.
- **US3**: When new cases are scraped and saved, `case.json` `url` property must point to `Communication` tab (`tabset-XXXX=1`).

## 4. Deep Modules Map
- `scripts/open_qc_case.mjs`: Core URI parser & Chrome/CDP dispatcher. Export `ensureCommunicationTabUrl(url)` and use it in `resolveTargetUrl`.
- `.claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs`: Persistence post-processor. Normalize `url` before writing `case.json`.
- `data/cases/*/case.json` & `data/cases/_overview.json`: Existing case data stores.
- `tests/open_qc_case.test.mjs` & `tests/scrape_case.test.mjs`: Test suites.

## 5. Testing Decisions
- Unit tests in `tests/open_qc_case.test.mjs` verifying parameter rewriting (`tabset-XXXX=2` -> `tabset-XXXX=1`, preserving other query params).
- Integration tests in `tests/scrape_case.test.mjs` verifying `finalize()` persists Communication tab URLs.
- Full test suite execution (`npm test`) to ensure 100% pass rate.
