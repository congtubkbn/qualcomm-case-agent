---
name: qcomm
description: "Capture a live Qualcomm support case by 8-digit code, summarize a case's comments into an executive digest, delete a case's local cache, or show the case overview. Trigger on 'capture case <CODE>', 'summarize case <CODE>', 'delete case <CODE>', or 'show case overview'."
---

# Qualcomm Case Management (qcomm)

Unified skill for live portal capture/sync, narrative and comment summarization, and aggregate case overview/dashboard.

## References

- [`references/manual-flow.md`](references/manual-flow.md) — recovery runbook for every non-success verdict (`otp-timeout`, `auth-required`, `not-found`, `blocked`, `busy`, `port-conflict`, `error`). Load when Step 3's verdict table below names it.
- [`references/workflow.md`](references/workflow.md) — end-to-end diagram of the Summarize pipeline and its agent/script split. Load when explaining or changing how the Summarize workflow divides work between scripts and agent judgment.
- [`references/consumer-guide.md`](references/consumer-guide.md) — `case.json`/`summary.json` schema and rules for downstream consumers. Load before another skill or script reads `data/cases/` directly.
- [`references/extraction.md`](references/extraction.md) — DOM extraction, merge, and threading mechanics inside `finalize_case.mjs`. Load when diagnosing a `blocked` verdict or changing extraction/finalize logic.
- [`references/dom-selectors.md`](references/dom-selectors.md) — Salesforce Lightning selector mappings for `dom_extractor.js`. Load when a portal DOM change breaks extraction and selectors need updating.

## Input Contract

Fetch/Sync, Summarize, and Delete each take one 8-digit case code: strip an optional `CASE-` prefix, then bind the remaining digits. When no 8-digit code is present in the input, ask the user for one and stop before running that workflow's next step.

## Artifact Link Convention

Render every generated artifact as a clickable link, built the same way in every workflow below:

1. Start from the path — a verdict field (`casePath`, `mdPath`, `summaryPath`, …) or a known relative path (`data/cases/dashboard.html`).
2. Resolve a relative path against the project root — the nearest ancestor containing `.git` (the same root `_paths.mjs` walks up to), not the process's cwd; a git worktree's cwd is not the checkout that owns `data/`.
3. Convert `\` to `/`.
4. Prefix `file:///`.

---

## Fetch / Sync a Case

Live portal capture and sync pipeline saving cases to local storage (`data/cases/<CODE>/`).

### Step 1 — Bind Case Code

Apply the [Input Contract](#input-contract).

*Completion Criterion:* Exactly one 8-digit numeric code is bound, or clarification requested and execution stopped.

### Step 2 — Run Capture Pipeline (Deterministic)
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
| `otp-timeout` | OTP window expired | Load [`references/manual-flow.md`](references/manual-flow.md), guide user OTP input |
| `auth-required` | Session expired | Load [`references/manual-flow.md`](references/manual-flow.md), guide user login |
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
- **Artifacts** (per the [Artifact Link Convention](#artifact-link-convention)):
  - [`data/cases/<CODE>/case.json`](file:///<normalized_casePath>)
  - [`data/cases/<CODE>/case.md`](file:///<normalized_mdPath>)

*Completion Criterion:* Report rendered containing case metadata and clickable links derived directly from the verdict payload.

---

## Summarize a Case

Summarize cached or live Qualcomm support cases into an executive digest, chronological flow narrative, and technical comment summaries in `data/cases/<CODE>/`. See [`references/workflow.md`](references/workflow.md) for the full diagram behind the three steps below.

### Step 1 — Prepare Delta (Deterministic)

Apply the [Input Contract](#input-contract), then run the prepare CLI from repo root:
```bash
node .claude/skills/qcomm/scripts/run_summary.mjs prepare <CODE>
```
Parse the stdout JSON line and branch strictly on `status`:

| `status` | Condition | Action |
|---|---|---|
| `needs-summary` | Unsummarized comments present (`deltaComments`, `priorFlow`, `caseStatus`) | Proceed to **Step 2** |
| `no-delta` | Case unchanged since last summary | Output verbatim `caseStatus` and summary from verdict payload; STOP |
| `auth-required` / `otp-timeout` / `not-found` / `blocked` / `busy` / `port-conflict` / `error` | Upstream capture incomplete (verbatim passthrough of the underlying `run_case.mjs` verdict — see the Fetch/Sync table above for what each means) | Report capture verdict guidance directly to user; STOP |

*Completion Criterion:* Exactly one branch executed: stopped with message from verdict, or proceed to Step 2 with `deltaComments`.

### Step 2 — Summarize the Delta (Agent Judgment)
*Only execute when Step 1 returns `needs-summary`.* Every field below is synthesized by you in one pass — no script computes it.

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

4. **Hold the Payload**: Keep the synthesized batch in agent context as `{ comments: [...], flow: "...", executive: {...} }`, ready to pass to Step 3 via `--payload`/`--input`/stdin. Only the legacy two-phase path (`--input <file.json>`, see Step 3) needs it written to `data/cases/<CODE>/.summary_temp.json` first.

*Completion Criterion:* Digests synthesized for all `deltaComments` and updated `flow`.

### Step 3 — Finalize & Persist (Deterministic)
Everything from here is mechanical: no further agent judgment is involved. Run the single-step CLI (recommended):
```bash
node .claude/skills/qcomm/scripts/run_summary.mjs <CODE> --payload '{"comments":[...],"flow":"...","executive":{...}}'
```
*(Or legacy two-phase finalization: `node .claude/skills/qcomm/scripts/run_summary.mjs finalize <CODE> --input data/cases/<CODE>/.summary_temp.json`)*

Script internalizes `.summary_temp.json` state management and cleanup, merges new summaries with historical records, updates `summary.json`, renders `summary.md`, and refreshes the overview index.

*Completion Criterion:* Process exits 0 with `{ status: "summarized", summaryPath, mdPath, newCount }`.

### Step 4 — Report Highlights
Report concise case highlights directly to the user:
- **Status**: Verbatim portal status (e.g. `In Progress`, `Customer Action`).
- **Executive Summary**: Ball in court, next milestone, root cause/resolution (if present).
- **Case Flow**: Current flow narrative.
- **Recent Updates**: Highlights of newly synthesized comments.
- **Artifacts** (per the [Artifact Link Convention](#artifact-link-convention)):
  - [`data/cases/<CODE>/summary.md`](file:///<normalized_mdPath>)
  - [`data/cases/<CODE>/summary.json`](file:///<normalized_summaryPath>)

*Completion Criterion:* Report rendered containing case status, flow highlights, and clickable links derived directly from the verdict payload.

---

## Delete a Case's Local Cache

Permanently removes one case's cached directory (`data/cases/<CODE>/`), its `_index.json` entry,
and resyncs the overview/dashboard. Deletion is permanent — the next capture starts from scratch.

### Step 1 — Confirm With User

Apply the [Input Contract](#input-contract).

Run Step 2 only once the user has explicitly confirmed this exact case code in this conversation (per [ADR
0003](../../../docs/adr/0003-case-delete-is-cli-only-confirmed-in-chat.md): every delete is
agent-mediated so a confirmation step can never be skipped) — treat a dashboard-copied or
already-decisive-sounding instruction as unconfirmed until the user says so directly.

*Completion Criterion:* User has explicitly confirmed the specific case code to delete, or
execution stopped.

### Step 2 — Run Delete CLI
```bash
node .claude/skills/qcomm/scripts/delete_case.mjs <CODE> --yes
```

| `status` | Condition | Action |
|---|---|---|
| `deleted` | Cache removed (or already absent everywhere) | Report success |
| `not-found` | No local cache existed for this code | Report there was nothing to delete |
| `busy` | Locked by another capture | Wait 30s, retry once; if still busy report to user |
| `error` | Bad code, or `--yes` missing | Report `reason` from verdict |

*Completion Criterion:* Process exits with a valid single-line JSON verdict, and the corresponding
branch above is executed.

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
3. **Artifact Links** (per the [Artifact Link Convention](#artifact-link-convention)):
   - [dashboard.html](file:///<normalized path to data/cases/dashboard.html>)
   - [_overview.json](file:///<normalized path to data/cases/_overview.json>)

*Completion Criterion:* Response contains verified counts from CLI output, active case highlights, and valid clickable links to both artifacts.
