# qualcomm-case-agent — Consumer Interface Design

- Date: 2026-06-20
- Status: approved
- Related: [2026-06-20-qualcomm-case-agentic-pipeline-design.md](2026-06-20-qualcomm-case-agentic-pipeline-design.md)

## 1. Problem

Other agents, skills, and workflows (Agent B) need to access Qualcomm case data
produced by qualcomm-case-agent. There is no documented interface contract telling
Agent B: which file to read, what schema to expect, and when/how to trigger a sync.

## 2. Approach: Cache-first file read (Approach A)

Agent B owns the check-and-read logic. qualcomm-case-agent is invoked only when
the cache file is missing. No TTL or freshness policy in v1 (YAGNI — if file exists,
use it).

```
Agent B needs CASE-XXXXXXXX
  │
  ▼
data/cases/<CODE>.json exists?
  ├─ YES → read file directly, pick fields needed
  └─ NO  → invoke qualcomm-case-agent "sync case <CODE>"
              → pipeline runs (Stage 1 scrape + Stage 2 enrich)
              → file written
              → Agent B reads file
```

## 3. New artifact: consumer-guide.md

**Path:** `.claude/skills/qualcomm-case-agent/references/consumer-guide.md`

This file is the single source of truth Agent B reads to understand the interface.
It must not duplicate the full schema spec — point to the pipeline design doc for
complete schema. It covers:

### 3.1 Quick start (3 steps)

1. Check if `data/cases/<CODE>.json` exists.
2. If missing → invoke qualcomm-case-agent with the case code.
3. Read `data/cases/<CODE>.json` → pick the fields needed.

### 3.2 File paths

| File | Purpose |
|------|---------|
| `data/cases/_index.json` | Registry of all synced cases (`{<CODE>: {syncedAt, commentCount, hash, enrichedAt?}}`) |
| `data/cases/<CODE>.json` | Full case data (raw + enrichment) |
| `data/cases/<CODE>.report.md` | Human-readable summary (for quick context) |

### 3.3 Key schema fields

Agent B typically needs:

**Raw (always present):**
- `caseNumber`, `title`, `status`, `priority`, `severity`
- `comments[].id`, `comments[].author`, `comments[].body`, `comments[].analysisLog[]`
- `hash`, `extractedAt`

**Enrichment (present unless raw-only sync):**
- `enrichment.engineerSummary` — end-to-end debug narrative
- `enrichment.rootCause` — best current hypothesis
- `enrichment.tags[]` — e.g. `["NR","n78","desense"]`
- `enrichment.commentSummaries.<id>` — per-comment 2–4 sentence summary
- `enrichment.enrichedAt`

### 3.4 Invoke pattern

When `data/cases/<CODE>.json` is missing:

**Claude Code (Skill tool):**
```
Skill("qualcomm-case-agent") → "sync case <CODE>"
```

**Cline / VS Code:**
Send a message referencing the qualcomm-case-agent skill and the case code.
The `.clinerules/qualcomm-case-agent.md` entry point auto-loads in Cline.

### 3.5 Pseudocode

```js
const path = `data/cases/${CODE}.json`
if (!fileExists(path)) {
  invoke("qualcomm-case-agent", `sync case ${CODE}`)
  // wait for completion
}
const caseData = JSON.parse(readFile(path))
const summary  = caseData.enrichment?.engineerSummary   // may be absent (raw-only)
const rootCause = caseData.enrichment?.rootCause
const comments = caseData.comments                       // newest-first
```

## 4. What Agent B must NOT do

- Never mutate `data/cases/<CODE>.json` — read-only consumer.
- Never write to `data/cases/_index.json` — owned by qualcomm-case-agent.
- Never pass raw comment bodies to external services (NDA content).

## 5. Out of scope

- Freshness TTL / re-sync policy (v1: file exists → use it).
- Query/filter layer (Agent B reads full JSON, picks fields itself).
- Multi-case batch query (Agent B loops per code).
