# PRD: Streamline Case Navigation by Removing Redundant Web Links

## Problem Statement

Currently, the Dashboard HTML card toolbar renders a `🔗 Web Link` button and Markdown renderers (`case.md`, `summary.md`) include `[Web Link]` pointing directly to `https://support.qualcomm.com/s/...`.
However:
1. Standard browser tabs do not share the authenticated Okta/Qualcomm session stored in the dedicated Chrome profile (`access-qualcomm` user-data-dir). Clicking these standard web links fails to open the case automatically and redirects the user to login or an unauthenticated page.
2. Clicking the Case ID (`#08642051`) or Case Title directly triggers `qc://case/<id>`, which cleanly launches the authenticated dedicated Chrome profile via the registered protocol handler.
3. The presence of `🔗 Web Link` clutters the UI toolbar and causes user confusion.

## Solution

Streamline all case navigation strictly through the automated, authenticated `qc://` protocol:
1. **Dashboard HTML**:
   - Remove the `🔗 Web Link` action button from case cards.
   - Retain `qc://` links on Case ID (`#<caseNumber>`) and Case Title.
   - Keep the `⚙️ Protocol Help` button and modal in the header, updated to explain `qc://` setup without references to "Web Link fallback".
2. **Markdown Renders (`case.md`, `summary.md`)**:
   - Remove `· [Web Link](<url>)` from Portal metadata lines.
   - Standardize Portal line to: `- **Portal:** [Open in Qualcomm Profile (qc://)](qc://case/<caseNumber>)` (or `#<caseNumber>`).
3. **Documentation & Tests**:
   - Update test suites (`cases_overview_render.test.mjs`, `render_case.test.mjs`, `qualcomm_case_summary_metadata.test.mjs`) to assert clean UI without `Web Link`.
   - Update `README.md` and docs.

## User Stories

1. As a user viewing `dashboard.html`, I want each case card toolbar to be clean without non-functional `🔗 Web Link` buttons, and I want clicking `#<caseNumber>` or Title to seamlessly open the case in my authenticated Qualcomm Chrome profile (`qc://`).
2. As a developer reading `case.md` or `summary.md`, I want the portal link to point directly to `qc://case/<id>` without broken unauthenticated web links.
3. As a developer running `npm test`, all render assertions must pass 100% cleanly.

## Deep Modules Map

- `.claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs` & `.agents/skills/qualcomm-case-overview/scripts/cases_overview.mjs`: Dashboard HTML renderers.
- `.claude/skills/qualcomm-case/scripts/render_case.mjs` & `.agents/skills/qualcomm-case/scripts/render_case.mjs`: Case Markdown renderer.
- `.claude/skills/qualcomm-case-summary/scripts/render_summary.mjs` & `.agents/skills/qualcomm-case-summary/scripts/render_summary.mjs`: Summary Markdown renderer.
- `tests/cases_overview_render.test.mjs`, `tests/render_case.test.mjs`, `tests/qualcomm_case_summary_metadata.test.mjs`: Test suites.
- `README.md`: System documentation.

## Testing Decisions

- Unit Tests:
  - Assert Dashboard HTML output contains `href="qc://case/..."` on ID/Title, and does NOT contain `🔗 Web Link` or `class="action-btn weblink-btn"`.
  - Assert Markdown files output `- **Portal:** [Open in Qualcomm Profile (qc://)](qc://case/<id>)` without `[Web Link]`.
- Integration & Regression Tests:
  - Run `npm test` across all test files to ensure 100% pass rate.

## Out of Scope

- Changing the underlying `scripts/open_qc_case.mjs` or `scripts/ensure_protocol.mjs` protocol registration logic.
- Modifying Qualcomm authentication mechanisms or Okta SSO flow.
