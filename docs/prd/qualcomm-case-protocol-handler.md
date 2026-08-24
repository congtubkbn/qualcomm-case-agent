# Qualcomm Case Custom Protocol Handler (`qc://`)

## Problem Statement

When an engineer reviews Qualcomm cases via the offline HTML dashboard (`dashboard.html`) or generated Markdown files (`case.md`, `summary.md`), clicking a case link opens the system default Chrome browser with the user's personal default profile. Because the personal profile lacks the Qualcomm Okta Single Sign-On (SSO) session, cookies, and authentication state that are stored in the dedicated capture profile (`data/chrome-profile`), the engineer is blocked by an Okta login gate requiring manual username, password, and OTP verification every single time.

## Solution

Implement a Windows custom URL protocol handler registered under the `qc://` scheme (e.g. `qc://case/08603854` or `qc://08603854`) along with an intelligent, CDP-aware routing dispatcher.

When an engineer clicks a `qc://` link in either their IDE/Markdown viewer or the HTML Dashboard:
1. Windows invokes the protocol handler dispatcher (`open_qc_case.mjs`).
2. The dispatcher inspects the requested case code, resolves the destination Salesforce portal URL from the local cache (`data/cases/<caseNumber>/case.json`), or falls back to the portal search URL.
3. If Chrome with the dedicated profile (`data/chrome-profile`) is already running and listening on the Chrome DevTools Protocol (CDP) port (9773), the dispatcher immediately creates or activates a tab for that case URL via CDP without creating duplicate windows.
4. If Chrome is not running, the dispatcher launches Chrome using `connect_chrome.ps1` with `--user-data-dir="data/chrome-profile"` and opens the case URL directly in the authenticated browser session.
5. All generated artifacts (`case.md`, `summary.md`, and `dashboard.html`) render dual/smart links so engineers can access cases with 1-click in their authenticated session while retaining standard web URLs for external sharing.

## User Stories

1. As an engineer reviewing cases on the HTML Dashboard, I want clicking the case number or title to open the case directly in the authenticated Qualcomm Chrome profile via `qc://case/<codeNumber>`, so that I do not have to re-enter my credentials or OTP.
2. As an engineer reading `case.md` in my Markdown editor/IDE, I want a clickable `qc://case/<codeNumber>` link, so that I can jump into the live Qualcomm portal with a single click.
3. As an engineer reading `case.md` or `summary.md`, I want a companion `https://...` link alongside the `qc://` link, so that I can copy and share the standard web link with colleagues who do not have the local protocol handler installed.
4. As an engineer setting up my local environment on Windows, I want an `npm run setup:protocol` command that registers the `qc://` protocol in `HKCU:\Software\Classes\qc`, so that no Administrator/UAC elevation is required.
5. As an engineer maintaining my workstation, I want an `npm run uninstall:protocol` command to cleanly unregister the `qc://` protocol from Windows Registry without leaving dangling entries.
6. As an engineer clicking a case link when the dedicated Chrome browser is already running on CDP port 9773, I want a new tab to open immediately in that existing window, so that I don't spawn duplicate browser instances.
7. As an engineer clicking a case link when Chrome is closed, I want the handler to automatically launch Chrome with `--user-data-dir="data/chrome-profile"` and navigate directly to the case, so that I don't have to manually start Chrome first.
8. As an engineer opening a case that hasn't been cached locally yet, I want the handler to open the global search page on Qualcomm Support Portal for that case code, so that I can still find and view the case directly.
9. As an engineer opening an arbitrary Qualcomm Support URL via `qc://open?url=...`, I want the handler to validate and navigate to that Qualcomm URL safely.

## Implementation Decisions

- **Protocol Scheme & URL Contract**:
  - Registered scheme: `qc`
  - Supported URL patterns:
    - `qc://case/<8-digit-case-code>` (e.g. `qc://case/08603854`)
    - `qc://<8-digit-case-code>` (shorthand e.g. `qc://08603854`)
    - `qc://open?url=<encoded-url>` (direct portal navigation)
- **Windows Registry Integration**:
  - Registered in user space under `HKCU:\Software\Classes\qc` via PowerShell script `register_protocol.ps1` / `unregister_protocol.ps1`.
  - Registered command calls Node with the absolute path to `open_qc_case.mjs` and `%1` as argument.
  - Zero admin permissions or UAC prompts required.
- **CDP-Aware Navigation Dispatcher**:
  - Dispatcher script `open_qc_case.mjs` parses the incoming `qc://` URI.
  - Target URL resolution order:
    1. Direct URL if passed via `url` query parameter (restricted to `support.qualcomm.com` domain).
    2. Local `data/cases/<caseNumber>/case.json`'s `url` property if present.
    3. Fallback: `https://support.qualcomm.com/s/global-search/<caseNumber>`.
  - CDP inspection: checks `http://127.0.0.1:9773/json/version`.
    - If active: communicates via CDP `/json/new?` or `Target.createTarget` to create a new tab and focus the window.
    - If inactive: calls `connect_chrome.ps1` passing the target URL so Chrome launches directly to that page.
- **Markdown & Dashboard Presentation**:
  - `render_case.mjs`: renders dual links:
    `- **Portal:** [Open in Qualcomm (qc://)](qc://case/<caseNumber>) · [Web Link](<caseUrl>)`
  - `cases_overview.mjs`: renders `#<caseNumber>` and Case Title anchor `href` pointing to `qc://case/<caseNumber>` with tooltip `Open in Qualcomm Profile (qc://)`, while preserving copy actions.
- **Package Scripts**:
  - Add `setup:protocol` (`powershell -ExecutionPolicy Bypass -File scripts/register_protocol.ps1`) to `package.json`.
  - Add `uninstall:protocol` (`powershell -ExecutionPolicy Bypass -File scripts/unregister_protocol.ps1`) to `package.json`.

## Testing Decisions

- **Boundary / Seam for Tests**:
  - Behavior-only testing using `node --test` in `tests/open_qc_case.test.mjs`.
  - Mock CDP HTTP responses and process launch adapters to verify URI parsing, URL resolution from `case.json`, search fallback logic, and CDP payload dispatching without launching physical windows during test runs.
  - Test Markdown rendering in `tests/render_case.test.mjs` to ensure dual links are generated correctly.
  - Test Dashboard HTML rendering in `tests/cases_overview_render.test.mjs` to ensure `qc://` links are produced.
- **Prior Art**:
  - `tests/cdp_client.test.mjs` for CDP interaction patterns.
  - `tests/render_case.test.mjs` for Markdown snapshot assertions.
  - `tests/cases_overview_render.test.mjs` for HTML structure assertions.

## Out of Scope

- Automated login or OTP bypass if the Okta session expires (human-in-the-loop manual sign-in is required per security policy).
- Support for non-Windows operating systems (Linux/macOS).
- Overriding the user's system-wide default browser choice for non-`qc://` links.

## Further Notes

- The handler script handles execution gracefully in both headless and terminal-less background scenarios (e.g. invoked directly by Windows Shell `ShellExecute`).
