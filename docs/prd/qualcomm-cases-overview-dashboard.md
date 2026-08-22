# PRD: Multi-Case Overview & Interactive Dashboard for Qualcomm Cases

## Problem Statement

Users and agents manage dozens to ~100 Qualcomm cases stored locally in `data/cases/<case_number>/` (`case.json`, `summary.json`, `case.md`). Currently, to understand the current status, latest discussions, or resolution progress across these cases, users have to open each individual directory or inspect files one by one. There is no unified view to:
1. Quickly inspect the status (Open, In Progress, Closed, Customer Action Required, etc.) across all cases.
2. View the 2-3 most recent comments / updates without opening individual case files.
3. Search and filter cases instantly by keyword, status, or assignee.
4. Access this overview via both terminal / AI agent prompts and a modern, responsive, offline-capable HTML Dashboard.

## Solution

Build a dedicated downstream tool and skill (`qualcomm-case-overview` / `tools/cases_overview.mjs`) following the Deep Module principle:
1. **Centralized Fast Aggregation Cache (`data/cases/_overview.json`)**: Extracts case code, title, status, priority, AI executive summary (if available), and top 2-3 latest comments into an ultra-fast payload (< 10ms read time), with atomic writes and full `--rebuild` capability.
2. **Interactive HTML Dashboard (`data/cases/dashboard.html`)**: A self-contained, single-file HTML/CSS/JS dashboard with instant search, status filter tabs, copy-to-clipboard case number action, and expandable recent comments accordion. 100% offline and zero runtime server dependency.
3. **CLI & Skill Integration (`npm run cases:overview`, `SKILL.md`)**: Enables both humans and AI agents to query case statuses in terminal/markdown format or open the graphical dashboard on demand.

## User Stories

1. As an engineer managing multiple Qualcomm cases, I want to run `npm run cases:overview` or ask the agent to show case statuses, so that I get a concise table summary of all active cases directly in my terminal.
2. As an engineer, I want to run `npm run cases:overview -- --open` (or `npm run cases:dashboard`), so that a standalone interactive HTML dashboard opens immediately in my default browser.
3. As a dashboard user, I want an instant search bar that filters cases in real-time by Case ID, Title, comment author, or text snippet, so that I can locate any case in less than a second.
4. As a dashboard user, I want status filter tabs (All, Open, In Progress, Closed, Action Required) and statistics counters, so that I can see the high-level workload and focus on actionable cases.
5. As a dashboard user, I want to click an accordion on any case card to preview the 2-3 most recent comments (author, timestamp, and message excerpt), so that I know the latest developments without navigating away.
6. As a dashboard user, I want a 1-click "Copy Case ID" button on each case card, so that I can quickly paste the ID into other tools without dealing with broken unauthenticated portal URLs.
7. As a system, I want an incremental hook that updates `_overview.json` whenever a case is captured or summarized by `qualcomm-case-agent` or `qualcomm-case-summary`, so that the overview remains perpetually synchronized.
8. As an engineer, I want a `--rebuild` command, so that I can cleanly regenerate `_overview.json` and `dashboard.html` from raw case files at any time.

## Implementation Decisions

1. **Deep Module Interface (`tools/cases_overview.mjs`)**:
   - `buildOverviewData(casesDir)`: Pure function scanning `data/cases/*/case.json` and `summary.json` to generate the normalized overview data object.
   - `updateCaseOverview(caseNumber, casesDir)`: Incrementally updates or inserts a single case record into `_overview.json`.
   - `renderDashboardHtml(overviewData)`: Generates a complete, zero-dependency, self-contained HTML document.
   - `renderCliTable(overviewData, filter)`: Formats and prints a clean ASCII/Markdown table for terminal and agent consumption.
2. **Data Schema (`data/cases/_overview.json`)**:
   ```json
   {
     "cases": [
       {
         "caseNumber": "08603854",
         "title": "...",
         "status": "Closed-Customer Requested",
         "priority": "2 - High",
         "product": "SM7635",
         "url": "https://...",
         "syncedAt": "2026-08-22T23:18:35.894Z",
         "lastCommentAt": "July 22, 2026 at 5:42 AM",
         "lastCommentAuthor": "Luyen Kieu Ba",
         "commentCount": 8,
         "hasSummary": true,
         "aiSummary": "Executive summary from summary.json if present...",
         "latestComments": [
           {
             "id": "cd589fb6339c1",
             "author": "Luyen Kieu Ba",
             "timestamp": "July 22, 2026 at 5:42 AM",
             "snippet": "MPSS. DE. Dear QCT..."
           }
         ]
       }
     ],
     "stats": {
       "total": 8,
       "byStatus": { "Closed": 1, "Open": 7 },
       "lastUpdated": "2026-08-23T..."
     }
   }
   ```
3. **No Direct Broken Portal Hyperlinks**:
   - Case headers display the prominent Case Number and a 1-click Copy button. Direct portal links are kept as secondary copyable metadata to prevent redirection to login walls when SSO session is not active in the default browser.
4. **Offline Single-File Dashboard Architecture**:
   - Built with modern vanilla JavaScript and embedded CSS (supporting responsive layout, clean dark/light UI palette, and instant client-side DOM filtering). Zero external CDN dependencies (no Google Fonts or CDN scripts that fail offline).
5. **Downstream Skill Isolation (ADR 0002 Compliance)**:
   - Built as a separate downstream skill `qualcomm-case-overview` (`.claude/skills/qualcomm-case-overview/SKILL.md`), without modifying core deterministic scraping logic in `qualcomm-case-agent`.

## Testing Decisions

1. **Test Strategy**: High-level external behavior testing using `node:test` and `node:assert/strict`.
2. **Module Test Coverage**:
   - `tests/cases_overview_data.test.mjs`: Tests scanning directory fixtures, extracting metadata, sorting comments, extracting top 3 latest comments, computing statistics, incremental single-case update, and atomic persistence of `_overview.json`.
   - `tests/cases_overview_render.test.mjs`: Tests HTML template generation, self-contained scripts, search/filter logic attributes, escaping special characters, and terminal table formatting.
   - `tests/cases_overview_cli.test.mjs`: Tests CLI flags (`--open`, `--rebuild`, `--filter`, `--json`, `--help`) and exit code contracts.
3. **Prior Art**: Follows patterns established in `tests/qualcomm_case_summary_merge.test.mjs` and `tests/render_case.test.mjs`.

## Out of Scope

1. Running a long-lived Node/Express background server.
2. Modifying the deterministic scraping engine or CDP browser automation in `qualcomm-case-agent`.
3. Mutating or submitting comments back to Qualcomm Support Portal.
