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
| `data/cases/_index.json` | Registry (root): `{ "<CODE>": { syncedAt, commentCount, hash } }` |
| `data/cases/<CODE>/case.json` | Full case data (see schema below) |
| `data/cases/<CODE>/case.md` | Full human review — every comment verbatim |

## Key schema fields

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
const comments  = caseData.comments;                       // newest-first
```

## Rules for consumers

- **Read-only.** Never write to `data/cases/<CODE>/case.json` or `data/cases/_index.json`.
  Both are owned by qualcomm-case-agent.
- **NDA content.** Never pass `comments[].body` or `comments[].analysisLog` verbatim to
  external services. These contain Qualcomm NDA material.
- **Comments are newest-first.** Index 0 is the most recent comment.

## Full schema reference

The fields above are the complete consumer-relevant shape. For the canonical persisted `case.json`
layout (including internal fields like `capture`/`verified`), see `SKILL.md` PHASE 4 (Persist), or
read `scripts/scrape_case.mjs` / `scripts/render_case.mjs` directly — they are the source of truth.
