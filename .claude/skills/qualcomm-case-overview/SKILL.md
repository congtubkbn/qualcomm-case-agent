---
name: qualcomm-case-overview
description: Compile and inspect the aggregated overview and offline HTML dashboard for cached Qualcomm cases under data/cases/. Use when asked to list, view, or filter cached cases, or open the cases dashboard.
---

# Qualcomm Case Overview & Dashboard

A multi-case aggregation engine and offline HTML dashboard for Qualcomm support cases cached under `data/cases/`.

**Downstream Consumer.** Read-only consumer of `case.json` (from `qualcomm-case-agent`) and `summary.json` (from `qualcomm-case-summary`). Preserves upstream case records untouched.

---

## Execution Workflow

Three sequential steps. Execute the CLI immediately to compile aggregates and open the dashboard, verify the output files, then report the structured summary.

### Step 1 — Run Overview CLI

Execute immediately upon invocation without waiting for intermediate confirmation or step selection.

Run the default command (scans cases, compiles `dashboard.html`, and opens it in the default browser):
```bash
node ".claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs"
```

Append flags only when explicitly requested by user prompt or environment:
- `--filter=<status>`: Filter output by status (e.g. `In Progress`, `Customer Action`, `Closed`).
- `--no-open`: Suppress browser popup (for automated or headless runs).
- `--json`: Emit raw JSON to stdout (disables browser launch).
- `--rebuild`: Force full re-scan of case directories, bypassing cache.

*Completion Criterion:* Command exits with code 0 and emits the formatted overview table or JSON verdict to stdout.

### Step 2 — Verify Generated Artifacts

Verify that the aggregate artifacts exist and are current under `data/cases/`:
- `data/cases/_overview.json`: Atomic index containing case metadata and summary statistics.
- `data/cases/dashboard.html`: Single-file offline dashboard with zero server or CDN dependencies.

*Completion Criterion:* `_overview.json` and `dashboard.html` exist, are non-empty, and reflect current case directory timestamps.

### Step 3 — Report to User

Present a concise snapshot directly in the response:
1. **Summary Metrics**: Total case count and breakdown by status.
2. **Active Case Highlights**: List open cases with case number, title, product, owner/opener, and recent AI summary or comment snippet.
3. **Artifact Links**: Direct clickable links to generated files:
   - [Interactive Dashboard](file:///data/cases/dashboard.html)
   - [Overview Index](file:///data/cases/_overview.json)

*Completion Criterion:* Response contains verified case counts, open case details, and clickable links to both local artifacts.

---

## Auto-Sync Integration

`_overview.json` and `dashboard.html` synchronize automatically via `afterFinalize` hooks during upstream case processing:
1. `qualcomm-case-agent` (`finalize_case.mjs`): updates overview when capturing or syncing a case.
2. `qualcomm-case-summary` (`run_summary.mjs`): updates overview when generating or revising a case summary.

Direct invocation of this skill serves on-demand inspection, manual filtering, or forced cache rebuilds.

---

## Operational Guardrails

- **Immutable Upstream Seam**: Read case records exclusively via `overview_store.mjs` to keep raw `case.json` and `summary.json` files untouched.
- **Cache-First Reading**: Read from cached `_overview.json` by default; reserve `--rebuild` for explicit requests or detected cache corruption.
- **Local Boundary**: Retain all case data and generated dashboards strictly within the local workspace directory (`data/cases/`).
- **Headless Awareness**: Pair with `--no-open` or `--json` in automated workflows to avoid spawning unwanted browser windows.
