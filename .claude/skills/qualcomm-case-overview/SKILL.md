---
name: qualcomm-case-overview
description: "Multi-Case Overview & Interactive Dashboard for Qualcomm Cases. Aggregates all locally cached Qualcomm cases (`data/cases/<case_number>/`) into a fast summary table in the terminal or opens a modern, responsive, offline-capable interactive HTML dashboard (`data/cases/dashboard.html`). Allows filtering by status, searching by keywords/assignee/product, and previewing recent comments and AI executive summaries without opening individual case files. Triggers: 'list qualcomm cases', 'cases overview', 'show all cases', 'qualcomm dashboard', 'tổng quan các case', 'xem danh sách case'. Use whenever the user wants to see an overview, summary table, or dashboard of all managed Qualcomm cases."
allowed-tools: Bash(node:*), Bash(npm:*), Read, Write, Glob
---

# Qualcomm Cases Overview & Dashboard

**Role.** Downstream aggregation engine and interactive dashboard for Qualcomm cases cached locally under `data/cases/`.

**Downstream consumer.** Read-only consumer of `case.json` (produced by `qualcomm-case-agent`) and `summary.json` (produced by `qualcomm-case-summary`). Never modifies individual case files or capture logic.

---

## Capabilities & Usage

### 1. Terminal Case Summary & Auto-Launch Dashboard
Shows all active cases, status breakdown, AI summaries, and latest comments directly in terminal, and automatically launches `data/cases/dashboard.html` in the user's browser:

```bash
npm run cases:overview
```
or with status filtering:
```bash
node .claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs --filter=open
node .claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs --filter=in_progress
node .claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs --filter=closed
```

To run purely in terminal without automatically opening the browser:
```bash
node .claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs --no-open
```

### 2. Interactive Offline HTML Dashboard
Opens a self-contained, responsive dashboard in the default browser with:
- **Direct Case Links**: Click on Case ID or title to open the case in Qualcomm Support Portal (`target="_blank"`).
- **Hide / Unhide Cases**: Filter out completed/irrelevant cases into a dedicated "Hidden Cases" tab with 1-click restore.
- **Configurable Auto-Refresh Timer**: Auto-reloads dashboard periodically (intervals: `Off`, `1m`, `2m`, `5m` [default], `10m`, `15m`) with live countdown ticker and manual "🔄 Refresh Now" button.
- **State Persistence**: Active tab filters, search query, hidden cases, and auto-refresh settings survive page reloads via `localStorage`.
- **Raised By Metadata**: Shows case opener/creator on cards.
- **Comment Accordions & AI Summaries**: Expandable view for latest case updates.

```bash
npm run cases:dashboard
```
or:
```bash
node .claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs --open
```

### 3. Machine-Readable JSON Output
Emits normalized aggregated JSON payload to stdout:

```bash
node .claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs --json
```

### 4. Full Cache Rebuild
Forces a clean re-scan and regeneration of `data/cases/_overview.json` and `data/cases/dashboard.html`:

```bash
node .claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs --rebuild
```

---

## Artifacts & Storage

| Artifact | Path | Purpose |
|---|---|---|
| **Aggregated Overview Cache** | `data/cases/_overview.json` | Fast (<10ms) JSON index of all cases, status stats, and recent comment snippets. |
| **Interactive Dashboard** | `data/cases/dashboard.html` | Self-contained, single-file HTML/CSS/JS dashboard. Zero server or CDN dependency. |

---

## Auto-Sync Behavior

`_overview.json` and `dashboard.html` are automatically kept fresh via incremental hooks:
1. When a case is captured or updated by `qualcomm-case-agent` (`finalize_case.mjs`).
2. When a case is summarized by `qualcomm-case-summary` (`run_summary.mjs finalize`).

---

## Reporting Guidance for Agents

When the user asks for a case overview or list of cases:
1. Run `node .claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs` (or filter with `--filter=<status>`). This will output the summary and automatically launch the interactive dashboard in the user's browser.
2. Present the formatted output or summary statistics.
3. Inform the user that the dashboard is now open in their browser with auto-refresh and interactive filters.

