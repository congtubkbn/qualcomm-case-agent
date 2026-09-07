---
name: qualcomm-case-overview
description: Inspect cached Qualcomm cases or open the case dashboard. Use when asked to list, view, filter cases, or open the dashboard.
---

# Qualcomm Case Overview

Aggregates cached Qualcomm cases under `data/cases/` into a terminal overview table and an offline HTML dashboard.

## Workflow

Two sequential steps: execute the overview CLI, then report highlights directly to the user.

### Step 1 — Run Overview CLI

Execute the CLI orchestrator to compile case aggregates and display the overview:

```bash
node ".claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs"
```

Append optional flags when explicitly requested by the user:
- `--filter=<status>`: Filter output by status (e.g. `--filter="In Progress"`, `--filter="Closed"`).
- `--no-open`: Suppress browser popup (for headless runs or text-only inspection).
- `--rebuild`: Force full re-scan of raw case directories, bypassing cache.
- `--json`: Output raw JSON structure instead of formatted table.

*Completion Criterion:* Command exits with code 0 and outputs the formatted summary table or JSON to stdout.

### Step 2 — Report Highlights

Present a concise snapshot in the final response:
1. **Summary Metrics**: Total case count and breakdown by status.
2. **Active Cases**: List open cases (case number, title, product, owner/opener, and recent comment snippet). Cap at the 10 most recent if total exceeds 10.
3. **Artifact Links**: Direct clickable links to generated local artifacts:
   - Dashboard: [dashboard.html](data/cases/dashboard.html)
   - Overview Index: [_overview.json](data/cases/_overview.json)

*Completion Criterion:* Response contains verified counts from CLI output, active case highlights, and valid relative links to both artifacts.
