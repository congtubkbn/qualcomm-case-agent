# qualcomm-case-agent — Consumer Interface Guide

For agents, skills, and workflows (Agent B) that need Qualcomm case data produced by
qualcomm-case-agent. Read this before writing any code that accesses `data/cases/`.

## Quick start (3 steps)

1. Check if `data/cases/<CODE>/case.json` exists in the workspace.
2. If missing → invoke qualcomm-case-agent with the case code (see "Invoke pattern" below).
3. Read `data/cases/<CODE>/case.json` and pick the fields you need.

## File paths

All paths are relative to the workspace root. Each case has its own folder `data/cases/<CODE>/`;
only `_index.json` sits at the `data/cases/` root.

| File | Contents |
|------|----------|
| `data/cases/_index.json` | Registry (root): `{ "<CODE>": { syncedAt, commentCount, hash, enrichedAt? } }` |
| `data/cases/<CODE>/case.json` | Full case data — raw + enrichment (see schema below) |
| `data/cases/<CODE>/case.report.md` | Human-readable summary (quick context; no structured parsing needed) |
| `data/cases/<CODE>/case.md` / `.html` / `.txt` | Full human review — every comment verbatim + per-comment analysis (`.html` richest, `.txt` grep-friendly) |
| `data/cases/<CODE>/case.pdf` | Optional — PDF printed from the HTML report |

## Key schema fields

**Raw (always present):**
```json
{
  "caseNumber": "string",
  "title": "string",
  "status": "string",
  "priority": "string",
  "severity": "string",
  "product": "string",
  "customer": "string",
  "description": "string",
  "url": "string",
  "displayedCommentCount": 0,
  "comments": [
    {
      "id": "stable id",
      "timestamp": "string",
      "company": "string",
      "author": "string",
      "role": "string",
      "body": "verbatim text",
      "analysisLog": ["verbatim"],
      "attachments": [{ "name": "string", "href": "string" }]
    }
  ],
  "hash": "sha256 over raw",
  "extractedAt": "ISO-8601"
}
```

**Enrichment (present unless raw-only sync — always check before reading):**
```json
{
  "enrichment": {
    "engineerSummary": "5-8 sentence overview",
    "currentStatus": "1-2 sentences: where the case stands now",
    "rootCause": "best hypothesis or Unresolved",
    "caseFlow": [
      { "step": 1, "phase": "Symptom|Hypothesis|Experiment|Data/Log|Analysis|Request|Decision|Resolution|Pending",
        "date": "string", "by": "string", "what": "string", "refComments": ["<comment id>"] }
    ],
    "openQuestions": ["unanswered question / awaiting feedback"],
    "recommendedActions": ["string"],
    "tags": ["NR", "n78", "desense"],
    "timeline": [{ "date": "string", "event": "string" }],
    "commentAnalyses": {
      "<comment id>": {
        "summary": "2-4 sentence summary",
        "role": "Symptom|Question|Hypothesis|Data/Log|Analysis|Request|Resolution|Info",
        "keyPoints": ["string"],
        "citations": ["TS 38.331 §5.3.7"],
        "answered": true
      }
    },
    "enrichedAt": "ISO-8601"
  }
}
```

> **Schema note:** older caches may carry a flat `commentSummaries: { "<id>": "string" }` instead of
> `commentAnalyses`. Consumers that read per-comment analysis should check `commentAnalyses` first,
> then fall back to `commentSummaries`. The renderer (`render_case.mjs`) handles both.

## Invoke pattern

When `data/cases/<CODE>/case.json` is missing:

**Claude Code (Skill tool):**
```
Skill("qualcomm-case-agent") → say "sync case <CODE>"
```

**Cline / VS Code:**
Reference the qualcomm-case-agent skill and the case code in your message.
Cline auto-loads the skill from `.clinerules/qualcomm-case-agent.md`.

## Pseudocode

```javascript
const casePath = `data/cases/${CODE}/case.json`;
if (!fileExists(casePath)) {
  invoke('qualcomm-case-agent', `sync case ${CODE}`);
  // wait for completion
}
const caseData = JSON.parse(readFile(casePath));
const summary   = caseData.enrichment?.engineerSummary;   // may be absent (raw-only)
const rootCause = caseData.enrichment?.rootCause;
const comments  = caseData.comments;                       // newest-first
```

## Rules for consumers

- **Read-only.** Never write to `data/cases/<CODE>/case.json` or `data/cases/_index.json`.
  Both are owned by qualcomm-case-agent.
- **NDA content.** Never pass `comments[].body` or `comments[].analysisLog` verbatim to
  external services. These contain Qualcomm NDA material.
- **Enrichment may be absent.** Always check `caseData.enrichment` before reading enrichment
  fields (`engineerSummary`, `rootCause`, etc.). A raw-only sync produces no `enrichment` key.
- **Comments are newest-first.** Index 0 is the most recent comment.

## Full schema reference

See `docs/superpowers/specs/2026-06-20-qualcomm-case-agent-consumer-interface-design.md`.
