---
ID: #51
Status: AFK
Blocked by: [#50]
Type: Tracer Bullet
---

# Issue #51: qualcomm-case-summary: Case-level Metadata Header, Executive Status Snapshot, and Key Resolution Indexing

## Problem Statement

While Issue #50 provides rich per-comment annotations (`kind`, `impact`, `owner`, `references`), `summary.md` and `summary.json` currently lack macro-level context at the case header:
1. **Missing Case Title & Context**: `summary.md` renders only `# Case <CODE> — <Status>`. An engineer opening the file cold cannot see the Case Title (e.g. `[SIDIA Ecall Test] SEAU_5G_IMS_Ecall_VoNR_redial_TC1_RTD`), Priority, Product, or Qualcomm portal URL without searching `case.json`.
2. **Missing Executive Standup / Reporting Snapshot**: For daily standups and management syncs, an engineer or owner needs a 3-line snapshot answering: *What is the issue? Whose turn is it (Ball in Court: Qualcomm vs Customer)? What is the next immediate blocker/milestone?* Currently, this requires manually parsing individual comments.
3. **No Dedicated Resolution Index for Learning**: When an engineer searches closed cases to learn how a similar bug was resolved, the root cause and resolution (e.g. key CRs, patches, NV items, firmware build diffs) are buried inside the free-text `flow` prose.

## Solution

1. **Pass-through Case Metadata from `case.json` to `summary.json` & `summary.md`**:
   - `merge.mjs` captures `title`, `url`, `priority`, `product` from `case.json`.
   - `render_summary.mjs` renders a clean, clickable Markdown header block.
2. **Structured `executive` block in `summary.json` & `summary.md`**:
   - Step 2 Agent summarization produces an optional `executive` object in its intermediate payload:
     ```json
     {
       "ballInCourt": "qualcomm | customer | closed | unassigned",
       "blockerOrNextMilestone": "string",
       "rootCause": "string (optional)",
       "resolution": "string (optional, e.g. fix CRs, workaround, NV settings)"
     }
     ```
   - `render_summary.mjs` renders an `## Executive Summary` section above `## Case Flow`.
3. **Backward Compatibility**:
   - If `executive` or metadata fields (`title`, `url`, etc.) are missing (e.g., from older `summary.json` files), `render_summary.mjs` falls back gracefully without blank lines or throwing errors.

## User Stories

1. As an engineer opening a case summary, I want to see the case Title, Priority, Product, and a clickable link to the Qualcomm Case URL at the very top of `summary.md`, so that I immediately understand what subsystem and device the case applies to.
2. As a case owner or reporter in a daily standup, I want to see an Executive Snapshot with `Ball in Court` and `Next Milestone / Blocker`, so that I can copy-paste or report current status in 5 seconds.
3. As an engineer learning from a resolved case, I want to see the `Root Cause` and `Resolution / Key CRs` highlighted in a distinct section, so that I can apply the fix to my own case without reading the entire thread.
4. As a maintainer, I want `run_summary.mjs` and `merge.mjs` to seamlessly carry metadata from `case.json` without breaking the incremental delta processing or zero-token cost on `no-delta` runs.

## Implementation Decisions

### 1. Schema Extensions in `summary.json`
```json
{
  "caseNumber": "08642051",
  "title": "[P260803-02707] [SIDIA Ecall Test] SEAU_5G_IMS_Ecall_VoNR_redial_TC1_RTD",
  "url": "https://support.qualcomm.com/s/case/...",
  "priority": "1 - Critical",
  "product": "SDX75",
  "status": "Closed-Customer Requested",
  "executive": {
    "ballInCourt": "closed",
    "blockerOrNextMilestone": "Case resolved by customer",
    "rootCause": "Emergency service fallback ULInformationTransfer was not triggered on newer modem build 641",
    "resolution": "Disabled CR 4555226; test passes"
  },
  "flow": "...",
  "summarizedCommentIds": [...],
  "comments": [...],
  "lastSummarizedAt": "2026-08-23T05:40:00.000Z"
}
```

### 2. Output Format in `summary.md`
```markdown
# [08642051] [P260803-02707] [SIDIA Ecall Test] SEAU_5G_IMS_Ecall_VoNR_redial_TC1_RTD
- **Status**: Closed-Customer Requested
- **Priority**: 1 - Critical
- **Product**: SDX75
- **URL**: https://support.qualcomm.com/s/case/...

## Executive Summary
- **Ball in Court**: Closed
- **Next Milestone**: Case resolved by customer
- **Root Cause**: Emergency service fallback ULInformationTransfer was not triggered on newer modem build 641
- **Resolution**: Disabled CR 4555226; test passes

## Case Flow
...

## Comments (newest first)
...
```

### 3. File Modifications
- [MODIFY] `.claude/skills/qualcomm-case-summary/scripts/merge.mjs`: Pass through `title`, `url`, `priority`, `product`, and optional `executive` object from inputs into merged summary.
- [MODIFY] `.claude/skills/qualcomm-case-summary/scripts/run_summary.mjs`: Pass `caseJson.title`, `caseJson.url`, `caseJson.priority`, `caseJson.product` to `mergeSummary()`.
- [MODIFY] `.claude/skills/qualcomm-case-summary/scripts/render_summary.mjs`: Update `renderSummaryMd()` to render the metadata header and optional `## Executive Summary` section.
- [MODIFY] `.claude/skills/qualcomm-case-summary/SKILL.md`: Document `executive` structure in Step 2 instructions.
- [MODIFY] `.claude/skills/qualcomm-case-summary/references/workflow.md`: Update schema and flowchart documentation.
- [NEW] `tests/qualcomm_case_summary_metadata.test.mjs`: Unit tests for header rendering, executive block rendering, and backward-compatible fallbacks.

## Testing Decisions

- Unit tests in `tests/qualcomm_case_summary_metadata.test.mjs`:
  1. Full metadata + executive block renders all sections and links cleanly.
  2. Minimal summary (missing title/priority/executive) renders gracefully matching legacy output format.
  3. `mergeSummary` preserves existing metadata across multiple incremental runs.
- Existing tests in `tests/qualcomm_case_summary_render.test.mjs` and `tests/qualcomm_case_summary_merge.test.mjs` must remain 100% green.

## Out of Scope

- Mutating `qualcomm-case-agent` or modifying how `case.json` extracts metadata from the portal DOM.
- Creating an external database or search index for resolutions (handled in local filesystem JSON).
