---
name: qualcomm-case-summary
description: "Summarize Qualcomm case status, technical comment digest, and flow narrative. Triggers: 'summarize qualcomm case <CODE>' or 'case status <CODE>'."
allowed-tools: Bash(node:*), Read, Write
---

# Qualcomm Case Summary

**Role.** Synthesize a Qualcomm support case into an executive snapshot, a chronological flow narrative, and a compact per-comment technical digest. Persists structured `summary.json` and human-readable `summary.md` (newest-first) in `data/cases/<CODE>/`.

**Input Contract.** Exactly one 8-digit case code (e.g. `08642051`). Strip optional `CASE-` prefix.

**References** (`references/` — load on demand):
- [`references/workflow.md`](references/workflow.md): Flowchart, lifecycle, and architectural invariants.

---

## Execution Workflow

Four sequential steps. Deterministic scripts handle cache/delta/persistence; agent judgment performs the single-pass technical summarization.

### Step 1 — Prepare Delta
Run the prepare CLI:
```bash
node ".claude/skills/qualcomm-case-summary/scripts/run_summary.mjs" prepare <CODE>
```
Parse the stdout JSON line and branch strictly on `status`:

| `status` | Meaning | Action |
|---|---|---|
| `needs-summary` | Unsummarized comments present (`deltaComments`, `priorFlow`, `caseStatus`) | Proceed to **Step 2** |
| `no-delta` | Case unchanged since last summary | Report verbatim `caseStatus` and existing summary to user. **STOP** |
| `auth-required` / `not-found` / `blocked` / `busy` / `error` | Upstream capture incomplete (`capture` payload holds reason) | Report capture verdict guidance as-is. Do not attempt summarization. **STOP** |

### Step 2 — Agent Summarization (Single-Pass Model Judgment)
*Only execute when Step 1 returns `needs-summary`.*

1. **Per-Comment Digest**: For every comment in `deltaComments`, using its verbatim `body` (subject to 20k-char safety cap), produce a digest object:
```json
{
  "id": "<comment id>",
  "timestamp": "<comment timestamp>",
  "author": "<comment author>",
  "kind": "<optional: bug-report | acknowledgment | investigation-data | blocker | resolution | workaround | question | fyi>",
  "summary": "<optional: 1-2 sentence technical digest>",
  "impact": "<optional: blocker-introduced | blocker-resolved | investigation-started | hypothesis-narrowed | hypothesis-disproven | root-cause-found | awaiting-info | fyi>",
  "owner": "<optional: qualcomm | engineer | support | unassigned>",
  "nextAction": "<optional: concrete actor + action>",
  "references": ["<optional: referenced prior comment ids>"]
}
```
*Populate only fields relevant to the comment.*

2. **Flow Narrative**: Incrementally update the 1-2 paragraph `flow` narrative using `priorFlow` as context.

3. **Executive Summary** *(Optional, recommended once history allows)*:
```json
{
  "ballInCourt": "<qualcomm | customer | closed | unassigned>",
  "blockerOrNextMilestone": "<immediate next blocker or milestone>",
  "rootCause": "<optional: root cause once identified>",
  "resolution": "<optional: fix CRs, workaround, NV settings once resolved>"
}
```

4. **Write Payload**: Save the batch to a temporary file (e.g. `.scratch/summary_<CODE>.json`):
```json
{
  "comments": [...],
  "flow": "...",
  "executive": { ... }
}
```

*Completion Criterion:* Temporary JSON written with all `deltaComments` processed.

### Step 3 — Finalize & Persist
Run the finalize CLI:
```bash
node ".claude/skills/qualcomm-case-summary/scripts/run_summary.mjs" finalize <CODE> --input <path-to-temp-json>
```
Script merges new summaries with historical records, carries case metadata from `case.json`, writes `data/cases/<CODE>/summary.json`, renders `data/cases/<CODE>/summary.md`, and triggers overview auto-sync.

*Completion Criterion:* Finalize returns `{ status: "summarized", summaryPath, mdPath, newCount }`.

### Step 4 — Report to User
Report concise case highlights directly to the user:
- **Status**: Verbatim portal status (e.g. `In Progress`, `Customer Action`).
- **Executive Summary**: Ball in court, next milestone, root cause/resolution (if populated).
- **Case Flow**: Current flow narrative.
- **Recent Updates**: Highlights of the latest comment digests.
- **Artifact Link**: Pointer to [summary.md](file:///data/cases/<CODE>/summary.md).

---

## Operational Guardrails

- **Read-only consumer:** Read `case.json` through `run_summary.mjs`; never modify `case.json` or `_index.json`.
- **Single model pass:** Process the entire `deltaComments` batch in one prompt pass.
- **Verbatim Status passthrough:** Preserve case Status exactly as reported by portal without inference.
- **Local confidentiality:** Retain all case data within local workspace (`data/cases/`).
- **Single case scope:** One case per invocation.
