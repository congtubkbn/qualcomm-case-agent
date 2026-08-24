# PRD: Auto Protocol Registration & Dashboard Dual-Mode Link Fallback

## Problem Statement

When cloning or sharing the `access-qualcomm` workspace to a new PC or developer environment, the custom Windows protocol handler `qc://` is missing from the Windows Registry (`HKCU:\Software\Classes\qc`). 

As a result:
1. Clicking case IDs or titles in `dashboard.html` or `case.md` fails because Windows and the browser do not recognize the `qc://` protocol.
2. `dashboard.html` case cards currently only have `qc://` links and lack direct HTTPS Web Links, preventing users from opening cases directly in their standard browser.
3. There is no in-dashboard notice or automated self-healing mechanism to guide users or automatically register the protocol on new machines.

## Solution

Implement a zero-friction, self-healing protocol registration workflow combined with dual-mode access and clear user guidance on the Dashboard:
1. **Automated Registration (`postinstall` + runtime self-healing)**:
   - Register `qc://` protocol automatically during `npm install`.
   - Perform an instant, silent check during CLI entrypoints (`npm run cases:dashboard`, `npm run case`); if missing on Windows, auto-register immediately for Current User without requiring UAC/Admin rights.
2. **Dashboard Dual-Mode Links & Protocol Help**:
   - Render a dedicated **`🔗 Web Link`** button on every Case Card to open direct HTTPS portal URLs in a new browser tab.
   - Retain `qc://` 1-click links for the dedicated Chrome profile workflow.
   - Add a **`⚙️ Protocol Help`** button on the Dashboard header with an interactive modal and 1-click copy for manual registration if needed.

## User Stories

1. As a developer cloning this repository to a new PC, I want `npm install` to automatically register the `qc://` protocol handler in Windows Registry so that I can click `qc://` links without running extra setup scripts.
2. As a user running `npm run cases:dashboard` or `npm run case`, I want the system to auto-detect and self-heal missing `qc://` registry keys so that case clicking always works out of the box.
3. As a dashboard viewer, I want a visible `🔗 Web Link` button on each case card so that I can immediately open the Salesforce/Qualcomm case in my current browser tab even if `qc://` is disabled.
4. As a user experiencing protocol launch issues, I want a `⚙️ Protocol Help` button on the Dashboard header so that I can see the protocol status and copy the 1-click PowerShell registration command.
5. As a developer running tests on non-Windows platforms (macOS/Linux CI), I want the registration hooks to run gracefully without errors.

## Implementation Decisions

- **Registry Scope**: Strictly `HKCU:\Software\Classes\qc` (Current User) — 0 UAC prompts, 0 admin privileges required.
- **Auto-Registration Seam**: A shared lightweight module `scripts/ensure_protocol.mjs` called by `postinstall` in `package.json` and on startup of `cases_overview.mjs` / `run_case.mjs`.
- **Dashboard Dual-Links**: Update `cases_overview.mjs` HTML generator to output `🔗 Web Link` buttons targeting `target="_blank" rel="noopener noreferrer"` with direct HTTPS URLs.
- **Protocol Help Modal**: Pure Vanilla CSS + JS modal in `dashboard.html` with clipboard copy helper and status indicator.

## Testing Decisions

- **Unit Tests**:
  - Test `ensure_protocol.mjs` behaves idempotently on Windows and returns cleanly on non-Windows platforms.
  - Test `cases_overview.mjs` HTML generator renders `🔗 Web Link` for cases with valid URLs and fallback search URLs.
  - Test `dashboard.html` renders protocol help modal structures and buttons.
- **Integration Tests**:
  - Run full test suite (`npm test`) confirming 100% pass across all existing 400+ tests without regressions.

## Out of Scope

- System-wide (`HKLM`) machine-level registry modification.
- Modifying Qualcomm authentication mechanisms or Okta SSO flow.

## Further Notes

All changes strictly follow zero-dependency Node.js practices and deep module conventions.
