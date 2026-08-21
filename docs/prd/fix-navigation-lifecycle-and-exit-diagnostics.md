# PRD: Fix Navigation Lifecycle & Search Landing Diagnostics in Qualcomm Case Agent

## 1. Problem Statement
When running `npm run case -- <CODE>` (e.g. `npm run case -- 08503838`), the pipeline prematurely failed with `status: "not-found"` (exit code 4) in ~1004ms even though valid cached case data existed in `data/cases/08503838/case.json`.

Root causes identified:
1. **CDP Navigation Race Condition & Context Destruction**: `CdpClient.navigate()` sent `Page.navigate` without awaiting navigation settlement or lifecycle events (`Page.loadEventFired` / `Page.frameNavigated`). When `cdp.eval(IN_PAGE_OBSERVE_SCRIPT)` executed immediately, Chrome was in mid-transition; navigating to the new page destroyed the JavaScript execution context (`Execution context was destroyed`).
2. **Silent Catch & Abrupt Fallback**: `fastLandOnCase` silently caught this error and immediately jumped to Global Search, which also suffered from incomplete hydration/timeout or 0 search results for closed/archived cases, resulting in an immediate false `NOT_FOUND` state.
3. **Lack of Failure Evidence**: When `NOT_FOUND` or `BLOCKED` states occurred, no diagnostic screenshot or detailed cause log was captured, making it difficult to differentiate between genuine missing access and transient navigation/script errors.

## 2. Solution Architecture
1. **Lifecycle-Aware Navigation in `cdp_client.mjs`**:
   - Enhance `navigate(url, { waitUntil = 'load', timeout = 15000 })` to enable `Page.enable` and await `Page.loadEventFired` or `Page.frameNavigated` / DOM readiness with a safe timeout fallback.
   - Add resilient evaluation retry in `cdp.eval` when encountering transient `"Execution context was destroyed"` or `"Cannot find context with specified id"` errors during in-flight navigations.
2. **Robust Direct Nav & Search in `fast_landing.mjs`**:
   - Refactor `fastLandOnCase` to cleanly handle Direct Navigation to cached URLs.
   - If direct navigation fails or encounters an error, record detailed diagnostic logs before falling back to Global Search.
   - For Global Search, ensure adequate wait time and DOM observer checks for Lightning table rendering.
3. **Enhanced Diagnostics & Evidence**:
   - When a case ends in `NOT_FOUND` or `BLOCKED` during search landing, capture a diagnostic screenshot (`landing_failure.png` or `search_not_found.png`) and include descriptive `reason` & `diagnostics` in the output verdict.
4. **Standardized Exit Codes**:
   - Preserve `STATUS_EXIT`: `created/updated/no-update: 0`, `auth-required: 3`, `not-found: 4`, `blocked: 5`, `busy: 6`, `error: 1`.

## 3. Out of Scope Boundary
- Modifying Web UI dashboard or external authentication credentials.
- Changing Qualcomm portal's server-side access rules or backend permissions.

## 4. User Stories & Definition of Done (DoD)
- **US1: Direct Navigation with Context Safety**
  - *Given* a case code with a cached `url` in `data/cases/<code\>/case.json`.
  - *When* `run_case.mjs` is executed.
  - *Then* `fastLandOnCase` directly navigates to the cached URL, handles page lifecycle events without throwing unhandled context destruction errors, and lands on the case successfully.
- **US2: Accurate Search Landing & Failure Diagnostics**
  - *Given* a case code without cache or whose cached URL is truly dead/redirected.
  - *When* Global Search runs and finds no results.
  - *Then* it captures a diagnostic screenshot, logs why search yielded 0 results, and exits with code 4 (`not-found`).
- **US3: Comprehensive Test Coverage**
  - *Given* the test suite in `tests/`.
  - *When* `npm test` is run.
  - *Then* 100% of unit and integration tests pass without regression.

## 5. Deep Modules Map
- `scripts/cdp_client.mjs`: Lifecycle event listeners (`Page.loadEventFired`), safe `navigate()` implementation, and retry on context destruction in `eval()`.
- `scripts/fast_landing.mjs`: Improved direct navigation resilience, fallback logging, and diagnostic capture.
- `scripts/run_case.mjs`: Enhanced verdict formatting with landing diagnostics and evidence screenshots for failed landings.
- `tests/fast_landing.test.mjs` & `tests/run_case.test.mjs`: Unit tests for navigation lifecycle, context destruction resilience, and failure diagnostics.

## 6. Testing Strategy
- Unit tests mocking CDP events and `Runtime.evaluate` context destructions.
- Verification that all status codes and exit codes map strictly to `STATUS_EXIT`.
- Automated test run via `npm test`.
