---
name: qualcomm-case-summary
description: "Summarize technical comments and narrative for a Qualcomm support case by 8-digit code. Trigger on 'summarize case <CODE>', 'case summary <CODE>'."
---

# Qualcomm Case Summary

Summarize cached or live Qualcomm support cases into an executive digest, chronological flow narrative, and technical comment summaries in `data/cases/<CODE>/`.

## Execution Flow

### Step 1 — Intake & Delta Preparation
Extract the 8-digit case code from input (strip optional `CASE-` prefix).
- Missing or non-8-digit code: Ask user for the 8-digit case code, then stop.

Run the prepare CLI from repo root:
```bash
node .claude/skills/qualcomm-case-summary/scripts/run_summary.mjs prepare <CODE>
```
Parse the stdout JSON line and branch strictly on `status`:

| `status` | Condition | Action |
|---|---|---|
| `needs-summary` | Unsummarized comments present (`deltaComments`, `priorFlow`, `caseStatus`) | Proceed to **Step 2** |
| `no-delta` | Case unchanged since last summary | Output verbatim `caseStatus` and summary from verdict payload; STOP |
| `auth-required` / `not-found` / `blocked` / `busy` / `error` | Upstream capture incomplete | Report capture verdict guidance directly to user; STOP |

*Completion Criterion:* Exactly one branch executed: stopped with message from verdict, or proceed to Step 2 with `deltaComments`.

### Step 2 — Single-Pass Technical Summarization
*Only execute when Step 1 returns `needs-summary`.*

1. **Per-Comment Digest**: For every comment in `deltaComments`, generate a digest object in a single pass (populate only fields relevant to the comment):
```json
{
  "id": "<comment id>",
  "timestamp": "<comment timestamp>",
  "author": "<comment author>",
  "kind": "<bug-report | acknowledgment | investigation-data | blocker | resolution | workaround | question | fyi>",
  "summary": "<1-2 sentence technical digest>",
  "impact": "<blocker-introduced | blocker-resolved | investigation-started | hypothesis-narrowed | hypothesis-disproven | root-cause-found | awaiting-info | fyi>",
  "owner": "<qualcomm | engineer | support | unassigned>",
  "nextAction": "<concrete actor + action>",
  "references": ["<referenced prior comment ids>"]
}
```

2. **Flow Narrative**: Update the 1-2 paragraph `flow` narrative incrementally using `priorFlow` as context.

3. **Executive Summary** (populate when comment history provides sufficient technical clarity):
```json
{
  "ballInCourt": "<qualcomm | customer | closed | unassigned>",
  "blockerOrNextMilestone": "<immediate next blocker or milestone>",
  "rootCause": "<identified root cause, if known>",
  "resolution": "<fix CRs, workaround, or NV settings, if resolved>"
}
```

4. **Write Payload**: Save the synthesized batch to `data/cases/<CODE>/.summary_temp.json`:
```json
{
  "comments": [...],
  "flow": "...",
  "executive": { ... }
}
```

*Completion Criterion:* Intermediate file `data/cases/<CODE>/.summary_temp.json` written containing digests for all `deltaComments` and updated `flow`.

### Step 3 — Finalize & Persist
Run the finalize CLI:
```bash
node .claude/skills/qualcomm-case-summary/scripts/run_summary.mjs finalize <CODE> --input data/cases/<CODE>/.summary_temp.json
```
Script merges new summaries with historical records, updates `summary.json`, renders `summary.md`, and refreshes the overview index.

*Completion Criterion:* Process exits 0 with `{ status: "summarized", summaryPath, mdPath, newCount }`.

### Step 4 — Report Highlights
Report concise case highlights directly to the user:
- **Status**: Verbatim portal status (e.g. `In Progress`, `Customer Action`).
- **Executive Summary**: Ball in court, next milestone, root cause/resolution (if present).
- **Case Flow**: Current flow narrative.
- **Recent Updates**: Highlights of newly synthesized comments.
- **Artifacts**:
  - [`data/cases/<CODE>/summary.md`](file:///<normalized_mdPath>)
  - [`data/cases/<CODE>/summary.json`](file:///<normalized_summaryPath>)

*(Note: Convert backslashes `\` in `mdPath` and `summaryPath` from the CLI verdict to forward slashes `/` to form valid clickable `file:///` URLs on any OS).*

*Completion Criterion:* Report rendered containing case status, flow highlights, and clickable links derived directly from the verdict payload.
