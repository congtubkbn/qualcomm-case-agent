# PRD: Qualcomm Cases Dashboard Interactive Enhancements & Auto-Launch

## Problem Statement

Currently, when users invoke `qualcomm-case-overview` skill, the default behavior only outputs a CLI table to the terminal and does not automatically launch the interactive HTML dashboard. Additionally, while developers need to actively manage and analyze Qualcomm cases:
1. There is no direct 1-click action to jump straight into the actual Qualcomm Support Portal case URL (`case.url`) to read full threads, comment, or perform real analysis.
2. Large numbers of cases clutter the dashboard view; developers need the ability to hide (and later unhide) specific cases on demand to focus on relevant workloads.
3. Cases currently lack visible metadata regarding who originally opened/raised the case (`raisedBy` / creator).
4. The dashboard is static and lacks an automated background refresh mechanism (with a configurable timer defaulting to 5 minutes) to detect new cases or comments saved locally.

## Solution

Upgrade the Qualcomm Case Overview and Dashboard engine (`tools/cases_overview.mjs` / `.claude/skills/qualcomm-case-overview/`):
1. **Auto-Launch Dashboard on Overview Skill Run**: Update the skill runner so running case overview default triggers automatic rendering and opening of `data/cases/dashboard.html` in the user's browser.
2. **Direct Qualcomm Portal Link & Click-Through**: Enhance case title and ID components to act as direct, accessible links opening `case.url` in a new tab (`target="_blank"`), allowing immediate navigation to Qualcomm Support Portal.
3. **Hide / Unhide Cases (Client-side Persistence)**: Introduce local storage-backed hide/unhide capabilities. Developers can click an icon to hide any case card. A "Hidden Cases (N)" filter tab allows viewing hidden cases with 1-click restoration ("Unhide").
4. **Auto-Refresh with Timer Setting (Default 5m)**: Add auto-reload functionality with configurable intervals (`Off`, `1m`, `2m`, `5m` [default], `10m`, `15m`), live countdown display, manual refresh button, and persistence of filter/search/hidden state across reloads.
5. **"Raised By" Creator Information**: Extract and display the case opener/creator (`raisedBy` / `contactName` / first post author) in both CLI output and the HTML dashboard cards.

---

## User Stories & Definition of Done (DoD)

### User Story 1: Direct Case Navigation
- **As a** developer viewing cases on the dashboard,
- **I want to** click on a case title or ID to directly open the actual case URL on the Qualcomm Support Portal in a new browser tab,
- **So that** I can immediately comment, analyze logs, or work on the real case.
- **DoD**: Clicking the case title or "Open Portal" link navigates to `case.url` with `target="_blank"` and `rel="noopener noreferrer"`.

### User Story 2: Hide & Unhide Cases
- **As a** developer managing dozens of cases,
- **I want to** hide cases I am not currently working on and see only relevant cases,
- **So that** my dashboard stays clean and focused.
- **DoD**:
  - Each case card has an intuitive "Hide" button.
  - Hidden case IDs are persisted in browser `localStorage`.
  - Filter bar displays a "Hidden (<count>)" tab.
  - When viewing hidden cases, an "Unhide" button restores the case back to normal views.

### User Story 3: Auto-Refresh Timer
- **As a** developer keeping the dashboard open on a second monitor,
- **I want** the dashboard to automatically reload cached data periodically (default 5 minutes) without losing my active search query or tab filter,
- **So that** newly scraped cases or summaries appear automatically.
- **DoD**:
  - Header has a dropdown selector: `[Off, 1 min, 2 min, 5 min (default), 10 min, 15 min]`.
  - Live countdown ticker (e.g. `Auto-refresh in: 04:30`) and a "🔄 Refresh Now" button.
  - State (active tab, search input, auto-refresh interval) persists across reloads via `localStorage`.

### User Story 4: Case Opener / "Raised By" Metadata
- **As a** developer reviewing case cards,
- **I want to** see who raised the case (Creator / Contact),
- **So that** I know who initiated the issue.
- **DoD**:
  - `extractCaseOverview` extracts `raisedBy` from `case.json` (`raisedBy`, `creator`, `contactName`, `openedBy` or first comment author fallback).
  - Both CLI overview table and HTML dashboard cards display `Raised by: <Author Name>`.

### User Story 5: Skill Auto-Launch
- **As a** developer invoking the `qualcomm-case-overview` skill,
- **I want** the dashboard to open in my browser immediately,
- **So that** I don't have to manually execute a second command.
- **DoD**: Running the skill instructions and default CLI runner launches the browser dashboard automatically.

---

## Deep Modules Map

| File | Type | Changes / Responsibility |
|---|---|---|
| `.claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs` | Core Module | Core aggregation & HTML generator logic: add `raisedBy` extraction, render click-through URLs, inject hide/unhide JS/CSS, auto-refresh dropdown, and `--open` default behavior. |
| `tools/cases_overview.mjs` | Mirror/Symlink | Mirror synchronization if present in workspace root tools. |
| `.claude/skills/qualcomm-case-overview/SKILL.md` | Skill Doc | Update skill instructions to clarify default browser auto-launch and new dashboard capabilities. |
| `tests/cases_overview.test.mjs` | Test Suite | Unit & integration tests for `raisedBy` extraction, `_overview.json` schema updates, and HTML dashboard rendering validation. |

---

## Testing Decisions

1. **Unit & Contract Tests (`tests/cases_overview.test.mjs`)**:
   - Verify `extractCaseOverview` correctly extracts `raisedBy` from case files and comment fallbacks.
   - Verify `renderDashboardHtml` includes direct `href` links, hide/unhide data attributes, auto-refresh timer scripts, and state restoration handlers.
   - Verify `updateCaseOverview` and `buildOverviewData` maintain backward compatibility with existing `_overview.json` consumers.
2. **End-to-End Visual / Browser Validation**:
   - Generate `data/cases/dashboard.html` against sample cases.
   - Verify theme toggle, hide/unhide flow, search filter, and countdown timers execute without JavaScript errors.
