# Workflow — Input, Processing, Output — Reference

How the Qualcomm Case Summary Skill (`qualcomm-case-summary`) runs end to end. Companion to `SKILL.md` and `docs/adr/0002-case-summary-as-separate-skill.md`.

**Two script steps, agent judgment in between.** Everything mechanical (ensuring capture, computing comment deltas, merging JSON, rendering Markdown) is handled by deterministic scripts. The technical summarization and case flow narrative update are produced by the agent in a single model pass.

---

## 1. Flow Diagram

```mermaid
flowchart TD
    User(["Input — 1 Qualcomm case code (e.g. 08642051)"]) --> VALID{"8 digits?<br/>(CASE- prefix stripped)"}
    VALID -->|"no"| S0(["ask user, STOP"])
    
    VALID -->|"yes"| STEP1["Step 1 (CLI): run_summary.mjs prepare &lt;CODE&gt;"]
    
    subgraph S1_ENGINE ["Step 1 Engine (Deterministic)"]
        STEP1 --> CAP["qualcomm-case-agent/capture_case.mjs: captureCase(&lt;CODE&gt;)<br/>calls qualcomm-case-agent (run_case.mjs)"]
        CAP --> CAP_CHECK{"Capture verdict?"}
        CAP_CHECK -->|"auth-required / not-found / blocked / busy / error"| CAP_ABORT["Return capture verdict as-is"]
        CAP_CHECK -->|"created / updated / no-update"| READ_CACHE["Read case.json & summary.json (if exists)"]
        READ_CACHE --> DELTA["delta.mjs: computeDelta()<br/>Set difference on comment IDs"]
        DELTA --> DELTA_CHECK{"delta.length > 0?"}
        DELTA_CHECK -->|"no (0 new comments)"| OUT_NODELTA["Return status: 'no-delta'<br/>+ cached summary + fresh caseStatus"]
        DELTA_CHECK -->|"yes (new comments)"| CAP_APPLY["cap.mjs: applyCharCapToComments (max 20k chars/comment)"]
        CAP_APPLY --> OUT_NEEDS["Return status: 'needs-summary'<br/>+ deltaComments + priorFlow + caseStatus"]
    end
    
    CAP_ABORT --> REPORT_CAP_ERR(["Surface capture recovery/error, STOP"])
    
    OUT_NODELTA --> REPORT_CACHED(["Report caseStatus + cached summary to user<br/>(Cost: 0 model tokens), STOP"])
    
    OUT_NEEDS --> STEP2["Step 2 (LLM Pass): Agent Summarization"]
    
    subgraph S2_AGENT ["Step 2 Agent Judgment (Single-Pass)"]
        STEP2 --> SUM_COMMENTS["Summarize each comment in deltaComments:<br/>- kind / summary / impact / owner / nextAction / references"]
        SUM_COMMENTS --> UPD_FLOW["Update case flow narrative (incremental based on priorFlow)"]
        UPD_FLOW --> WRITE_TEMP["Write intermediate batch to scratch/temp JSON<br/>{ comments: [...], flow: '...', executive: {...} }"]
    end
    
    WRITE_TEMP --> STEP3["Step 3 (CLI): run_summary.mjs finalize &lt;CODE&gt; --input &lt;temp.json&gt;"]
    
    subgraph S3_FINALIZER ["Step 3 Finalizer (Deterministic)"]
        STEP3 --> MERGE["merge.mjs: mergeSummary()<br/>Preserve prior summaries + append new batch + update flow, status, metadata & executive"]
        MERGE --> W_JSON["Write: data/cases/&lt;CODE&gt;/summary.json"]
        W_JSON --> RENDER["render_summary.mjs: renderSummaryMd()<br/>Format newest-first presentation"]
        RENDER --> W_MD["Write: data/cases/&lt;CODE&gt;/summary.md"]
        W_MD --> OUT_FINAL["Return status: 'summarized'<br/>{ summaryPath, mdPath, newCount }"]
    end
    
    OUT_FINAL --> REPORT_USER(["Report to User: Case Status + Flow narrative + Newest comment summaries"])
```

---

## 2. Step-by-Step Breakdown

### Step 0: Intake & Validation
- **Input Contract**: Exactly 8 digits (e.g. `08642051`). Optional `CASE-` prefix is stripped.
- **Immediate Execution**: Valid code proceeds straight to Step 1 without interactive confirmation.

### Step 1: Prepare (`run_summary.mjs prepare <CODE>`)
- Calls `qualcomm-case-agent`'s `captureCase` to guarantee local `case.json` is fresh.
- Computes `deltaComments = case.comments.filter(c => !prior.summarizedCommentIds.includes(c.id))`.
- **Branching**:
  - `status: "no-delta"`: No new comments. Returns current `caseStatus` and existing summary. **0 model tokens used**.
  - `status: "needs-summary"`: Returns new comments with a 20,000 character safety cap (`cap.mjs`), `priorFlow`, and `caseStatus`.
  - Capture failures (`auth-required`, `blocked`, etc.): Passthrough verdict to guide user/agent recovery.

### Step 2: Agent Summarization (Model Pass)
- Run within the active agent session for the `deltaComments` batch in one pass:
  - Produces per-comment digest: `id`, `timestamp`, `author`, `kind`, `summary`, `impact`, `owner`, `nextAction`, `references` (as applicable).
  - Updates the `flow` narrative incrementally using `priorFlow` as context.
  - Optionally produces an `executive` object (`ballInCourt`, `blockerOrNextMilestone`, `rootCause`, `resolution`) — a standup-ready snapshot, updated incrementally like `flow`.
- Saves payload `{ comments: [...], flow: "...", executive: {...} }` into a temporary JSON file (e.g. `temp/summary_<CODE>.json`); `executive` is optional.

### Step 3: Finalize (`run_summary.mjs finalize <CODE> --input <temp.json>`)
- Pure merge via `mergeSummary()`: Preserves previous comment summaries untouched, appends new ones in canonical order, updates `flow`, `status`, and `lastSummarizedAt`.
- Also carries `title`/`url`/`priority`/`product` through from `case.json` (no agent involvement — read directly by the orchestrator) and updates `executive` when the Step 2 payload includes one; a field missing from either source falls back to the prior merged value.
- Persists structured `summary.json`.
- Renders human-readable `summary.md` in **Newest-First** order, with a case metadata header and optional `## Executive Summary` section above `## Case Flow`.

### Step 4: User Reporting
- Outputs:
  1. **Case Status** (verbatim from Qualcomm portal).
  2. **Case Flow Narrative**.
  3. **Recent Comment Summaries** (with a link to `data/cases/<CODE>/summary.md`).

---

## 3. Output Artifacts (`data/cases/<CODE>/`)

| File | Owner | Format / Ordering | Purpose |
|:---|:---|:---|:---|
| `summary.json` | `qualcomm-case-summary` | JSON · Canonical storage | Structured summaries, comment IDs, flow narrative, and metadata |
| `summary.md` | `qualcomm-case-summary` | Markdown · **Newest-First** | Quick technical digestion for engineers |
| `case.json` | `qualcomm-case-agent` | JSON · **Newest-First** (replies grouped under parent) | Read-only input source of truth |

---

## 4. Architectural Invariants

1. **Downstream Read-Only Consumer**: Never mutates `case.json`, `_index.json`, or the capture pipeline.
2. **Deterministic Mechanics, Model for Judgment**: Script manages filesystem, delta, and formatting; LLM is used only for synthesizing technical meaning.
3. **Delta Efficiency**: Unchanged cases cost 0 model calls; updated cases process only unsummarized comments.
4. **Ordering**: `case.json` is newest-first (`orderCommentsForPresentation` — supersedes the original Oldest → Newest design in PRD #105-109); `summary.md` mirrors that newest-first order (ADR 0002, updated).
