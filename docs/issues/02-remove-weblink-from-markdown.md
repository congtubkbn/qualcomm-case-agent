---
ID: #122
Status: AFK
Blocked by: [#121]
Type: Refactor
---

# 02 (#122): Remove `[Web Link]` from Case & Summary Markdown Renderers

## Objective
Update Markdown renderers (`render_case.mjs` and `render_summary.mjs`) to eliminate `· [Web Link](<url>)` from the Portal line. Standardize Portal line to `- **Portal:** [Open in Qualcomm Profile (qc://)](qc://case/<caseNumber>)`.

## Acceptance Criteria
- [ ] `render_case.mjs` outputs `- **Portal:** [Open in Qualcomm Profile (qc://)](qc://case/<caseNumber>)` without `[Web Link]`.
- [ ] `render_summary.mjs` outputs `- **Portal**: [Open in Qualcomm Profile (qc://)](qc://case/<caseNumber>)` without `[Web Link]`.
- [ ] `tests/render_case.test.mjs` and `tests/qualcomm_case_summary_metadata.test.mjs` updated and passing.
