# Deep Overview Store and Synchronization Seam

The case overview cache (`_overview.json`) and dashboard are synchronized directly through `overview_store.mjs`'s `syncCaseOverview` seam, rather than through the CLI orchestrator `cases_overview.mjs`.

## Context
Upstream case processors (`finalize_case.mjs` and `run_summary.mjs`) previously invoked an `afterFinalize` hook imported from `cases_overview.mjs`, while `delete_case.mjs` imported `syncCaseOverview` from the same CLI script. This created role confusion: a CLI runner script was serving as a cross-skill library seam, re-exporting internal store logic and exposing an unnecessary wrapper layer.

## Decision
1. **Direct Store Seam**: All case mutation callers (`finalize_case.mjs`, `run_summary.mjs`, `delete_case.mjs`) import and call `syncCaseOverview` directly from `overview_store.mjs`.
2. **Subsume afterFinalize**: `syncCaseOverview` is already non-fatal and resilient; `afterFinalize` is subsumed by it and retained only as a deprecated alias in `overview_store.mjs`.
3. **Private Extraction Logic**: `extractCaseOverview` remains private to `overview_store.mjs`. It is not extracted into a shared reader module because no other skill consumes this specific aggregated projection.
4. **CLI As Thin Adapter**: `cases_overview.mjs` is strictly a CLI argument parser and browser launcher. It retains `@deprecated` re-exports for backward compatibility.
