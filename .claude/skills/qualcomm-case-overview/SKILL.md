---
name: qualcomm-case-overview
description: "Aggregated overview table and interactive offline HTML dashboard for all cached Qualcomm cases. Triggers: 'list qualcomm cases', 'qualcomm dashboard', 'cases overview', 'filter cases by status', 'tổng quan cases'."
allowed-tools: Bash(node:*), Bash(npm:*), Read, Write, Glob
---

# Qualcomm Case Overview & Dashboard

**Role.** Aggregated multi-case reporting engine and interactive offline HTML dashboard for all Qualcomm cases cached under `data/cases/`.

**Downstream Consumer.** Read-only consumer of `case.json` (from `qualcomm-case-agent`) and `summary.json` (from `qualcomm-case-summary`). Never modifies individual case files or upstream capture logic.

---

## Execution Workflow

Three sequential steps. Immediately run the CLI to build aggregates and auto-open the dashboard, then present the structured summary.

### Step 1 — Run Overview CLI (Immediate Fast-Path)
Execute immediately upon invocation. Do NOT prompt the user for confirmation or step selection.

Run the default command (scans cases, compiles `dashboard.html`, and auto-opens it in the default browser):
```bash
node ".claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs"
```
*(Only append flags if explicitly specified in the user's prompt: `--filter=<status>`, `--no-open` for headless/no browser popup, `--json` for machine output, or `--rebuild` for forced full cache re-scan).*

*Completion Criterion:* Command exits with code 0 and prints the formatted overview table.

### Step 2 — Verify Generated Artifacts
Ensure the cached aggregates exist and are current:
- `data/cases/_overview.json`: Atomic index containing case metadata and summary stats.
- `data/cases/dashboard.html`: Self-contained interactive dashboard.

*Completion Criterion:* `_overview.json` and `dashboard.html` verified in `data/cases/`.

### Step 3 — Report to User
Provide a clean snapshot in the response:
1. **Summary Metrics**: Total case count and status breakdown (e.g. `In Progress`, `Customer Action`, `Closed`).
2. **Key Cases**: Highlight active/open cases with case number, title, product, opener, and latest update / AI summary snippet.
3. **Artifact Links**: Direct clickable links to:
   - [Interactive Dashboard](file:///data/cases/dashboard.html) *(confirm auto-opened in browser)*
   - [Overview Index](file:///data/cases/_overview.json)

---

## Artifacts & Storage

| Artifact | Path | Purpose |
|---|---|---|
| **Aggregated Overview Cache** | `data/cases/_overview.json` | Fast (<10ms) JSON index of all cases, status statistics, and recent comment snippets. |
| **Interactive Dashboard** | `data/cases/dashboard.html` | Self-contained, single-file HTML/CSS/JS dashboard with zero server or CDN dependencies. |

---

## Auto-Sync Integration

`_overview.json` and `dashboard.html` are automatically kept synchronized via downstream hooks:
1. `qualcomm-case-agent` (`finalize_case.mjs` -> `afterFinalize`) upon capturing or updating any case.
2. `qualcomm-case-summary` (`run_summary.mjs finalize` -> `afterFinalize`) upon generating or updating a case summary.

---

## Operational Guardrails

- **Read-only aggregation:** Read case data through `overview_store.mjs`; never edit raw `case.json` or `summary.json` files during overview generation.
- **Cache-first efficiency:** Rely on `_overview.json` for fast response; invoke `--rebuild` only when explicitly requested or when cache corruption occurs.
- **Confidentiality:** All case records and overview artifacts remain strictly inside the local workspace (`data/cases/`).
- **Browser launch awareness:** In headless/automated test runs, use `--no-open` or `--json` to prevent unwanted browser spawns.
