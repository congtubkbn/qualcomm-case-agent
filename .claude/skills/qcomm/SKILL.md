---
name: qcomm
description: "Fetch/sync live Qualcomm support cases by 8-digit code, summarize technical comments and narrative, or inspect cached cases and open the case dashboard. Trigger on 'capture case <CODE>', 'fetch case <CODE>', 'sync case <CODE>', 'summarize case <CODE>', 'case summary <CODE>', or when asked to list, view, filter cases, or open the dashboard."
---

# Qualcomm Case Management (qcomm)

Unified skill for live portal capture/sync, narrative and comment summarization, and aggregate case overview/dashboard.

## Fetch / Sync a Case

Live portal capture and sync pipeline saving cases to local storage (`data/cases/<CODE>/`).

### Step 1 — Input Normalization
Extract the 8-digit case code from input (strip optional `CASE-` prefix).
- Missing or non-8-digit code: Ask user for the 8-digit case code, then stop.

*Completion Criterion:* Exactly one 8-digit numeric code is bound, or clarification requested and execution stopped.

### Step 2 — Run Capture Pipeline
Run the capture CLI:
```bash
node .claude/skills/qcomm/scripts/run_case.mjs <CODE>
```
*(Alternative from repo root: `npm run case -- <CODE>`. Append `--mode full` or `--mode update` only when explicitly requested by user).*

*Completion Criterion:* Process exits with a valid single-line JSON verdict on stdout.

### Step 3 — Dispatch on Verdict
Parse `status` from the JSON verdict and branch:

| `status` | Condition | Action |
|---|---|---|
| `created` | New case captured | Proceed to Step 4 |
| `updated` | New comments merged | Proceed to Step 4 |
| `no-update` | Already current | Report case is up to date, then stop |
| `otp-timeout` | OTP window expired | Load [`references/login-flow.md`](references/login-flow.md), guide user OTP input |
| `auth-required` | Session expired | Load [`references/login-flow.md`](references/login-flow.md), guide user login |
| `not-found` | Missing / unauthorized | Report case not found or unauthorized, then stop |
| `blocked` | Extraction stalled | Retry once if `retryable: true`; else load [`references/manual-flow.md`](references/manual-flow.md) |
| `busy` | Locked by other task | Wait 30s, retry once; if still busy load [`references/manual-flow.md`](references/manual-flow.md) |
| `port-conflict` | CDP port 9773 busy | Run `recover_chrome.ps1` per [`references/manual-flow.md`](references/manual-flow.md) |
| `error` | Pipeline failure | Report `reason` from verdict; retry once if transient |

*Completion Criterion:* Exactly one branch executed: stopped with message, remediation initiated via reference doc, or proceed to Step 4.

### Step 4 — Render Capture Report
Format report using fields from the stdout JSON verdict (`code`, `title`, `status`, `commentCount`, `newComments`, `casePath`, `mdPath`):

- **Case**: `<CODE>` — *<title>* (`<status>`)
- **Comments**: `<commentCount>` total (`<newComments>` new)
- **Artifacts**:
  - [`data/cases/<CODE>/case.json`](file:///<normalized_casePath>)
  - [`data/cases/<CODE>/case.md`](file:///<normalized_mdPath>)

*(Note: Convert backslashes `\` in `casePath` and `mdPath` to forward slashes `/` to form valid clickable `file:///` URLs on any OS).*

*Completion Criterion:* Report rendered containing case metadata and clickable links derived directly from the verdict payload.

---

## Summarize a Case

Summarize cached or live Qualcomm support cases into an executive digest, chronological flow narrative, and technical comment summaries in `data/cases/<CODE>/`.

### Step 1 — Intake & Delta Preparation
Extract the 8-digit case code from input (strip optional `CASE-` prefix).
- Missing or non-8-digit code: Ask user for the 8-digit case code, then stop.

Run the prepare CLI from repo root:
```bash
node .claude/skills/qcomm/scripts/run_summary.mjs prepare <CODE>
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
node .claude/skills/qcomm/scripts/run_summary.mjs finalize <CODE> --input data/cases/<CODE>/.summary_temp.json
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

---

## Overview / Dashboard

Aggregates cached Qualcomm cases under `data/cases/` into a terminal overview table and an offline HTML dashboard.

### Step 1 — Run Overview CLI

Execute the CLI orchestrator to compile case aggregates and display the overview:

```bash
node .claude/skills/qcomm/scripts/cases_overview.mjs
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
