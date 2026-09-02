# qualcomm-case-agent — Consumer Interface Guide

For agents, skills, and workflows (Agent B) that need Qualcomm case data produced by
qualcomm-case-agent. Read this before writing any code that accesses `data/cases/`.

## Quick start (3 steps)

1. Ensure the case is captured and fresh by invoking qualcomm-case-agent with the case code (see "Invoke pattern" below). Because the capture pipeline is incremental, unchanged cases return quickly without re-scraping.
2. Verify the JSON verdict returned on stdout: status will be `created`, `updated`, or `no-update` on success.
3. Read `data/cases/<CODE>/case.json` (or `data/cases/_overview.json` for cross-case summaries) and pick the fields you need.

## File paths

All paths are relative to the workspace root. Each case has its own folder `data/cases/<CODE>/`.
The root `data/cases/` holds the global index, multi-case overview, and dashboard:

| File | Contents |
|------|----------|
| `data/cases/_index.json` | Registry (root): `{ "<CODE>": { syncedAt, commentCount, hash } }` |
| `data/cases/_overview.json` | Aggregated multi-case overview data (status, priority, counts, etc.) |
| `data/cases/dashboard.html` | Visual multi-case HTML dashboard rendered by cases overview |
| `data/cases/<CODE>/case.json` | Full case data (see schema below) |
| `data/cases/<CODE>/case.md` | Full human review — every comment verbatim |

## Key schema fields

```json
{
  "caseNumber": "string",
  "title": "string | null",
  "status": "string | null",
  "priority": "string | null",
  "severity": "string | null",
  "product": "string | null",
  "accountName": "string | null",
  "contactName": "string | null",
  "customerProject": "string | null",
  "customerTracking": "string | null",
  "relatedCRs": "string | null",
  "caseRecordType": "string | null",
  "openedAt": "string | null",
  "closedAt": "string | null",
  "updated": "string | null",
  "description": "string | null",
  "url": "string",
  "displayedCommentCount": 0,
  "comments": [
    {
      "id": "stable id",
      "timestamp": "string",
      "rawTimestamp": "string (optional)",
      "author": "string",
      "body": "verbatim text",
      "summary": "1-2 sentence preview",
      "parentId": "string | null",
      "attachments": [{ "name": "string", "url": "string" }]
    }
  ],
  "detailExtracted": true,
  "hash": "sha256 over raw",
  "extractedAt": "ISO-8601"
}
```

### Notable field details

- **`detailExtracted`** (`boolean`): Tells a consumer whether the Salesforce Detail-tab extraction pass succeeded. If `detailExtracted` is `true`, a `null` in Detail-tab fields (`accountName`, `contactName`, `customerProject`, `customerTracking`, `relatedCRs`, `caseRecordType`, `openedAt`, `closedAt`) indicates genuine absence on the case. If `false`, the Detail tab pass failed or did not run during capture.
- **`comments[].summary`** (`string`, always present): 1-2 sentence preview automatically generated from `body`. Note: this is verbatim-derived from NDA comment text (see NDA rule below).
- **`comments[].rawTimestamp`** (`string`, conditional): When the portal's relative timestamp ("13h ago", "Yesterday", etc.) was resolved to an ISO-8601 string, the original portal string is preserved in `rawTimestamp`. Note: top-level timestamps and comments that were not rendered in relative format retain the portal's unnormalized format (e.g. `"7/23/2026, 6:46 PM"`).
- **`comments[].attachments`** (`array`): Objects contain `name` and `url` (download URL on the Qualcomm Support portal). Note the property is `url`, not `href`.

## Invoke pattern

To ensure case data is present and fresh, invoke qualcomm-case-agent with the 8-digit case code.
Do not gate invocation on file existence: the pipeline is incremental by design and will safely report `no-update` when the cache is already fresh.

**Headless CLI (used by automated consumers like `run_summary.mjs`):**
```bash
node .claude/skills/qualcomm-case-agent/scripts/run_case.mjs <CODE>
```
Stdout returns exactly one JSON verdict line:
```json
{"status":"created"|"updated"|"no-update", ...}
```

**Agent invocation (Claude Code, Cline, Antigravity):**
Invoke the `qualcomm-case-agent` skill or instruct the agent to capture/sync the case code:
```
sync case <CODE>
```

## Pseudocode

Matching the pattern used by `run_summary.mjs`:

```javascript
// 1. Invoke capture/sync unconditionally (incremental: fast no-op if unchanged)
const result = await exec(`node .claude/skills/qualcomm-case-agent/scripts/run_case.mjs ${CODE}`);
const verdict = JSON.parse(result.stdout.trim().split('\n').pop());

// 2. Branch on verdict status
if (['created', 'updated', 'no-update'].includes(verdict.status)) {
  const casePath = `data/cases/${CODE}/case.json`;
  const caseData = JSON.parse(readFile(casePath));
  const comments = caseData.comments; // newest-first, replies grouped under parent
} else {
  // Handle auth-required, blocked, not-found, busy, etc.
}
```

## Rules for consumers

- **Read-only.** Never write to `data/cases/<CODE>/case.json`, `data/cases/_index.json`,
  or `data/cases/_overview.json`. These are owned by qualcomm-case-agent.
- **NDA content.** Never pass `comments[].body` or `comments[].summary` verbatim to
  external services. Both contain Qualcomm NDA material (`comments[].summary` is directly
  derived from verbatim comment text).
- **Comments are newest-first.** Index 0 is the most recent comment; each reply (`parentId != null`)
  is grouped immediately after its parent Post (also newest-first among siblings) — see
  `finalize_case.mjs`'s `orderCommentsForPresentation`.

## Full schema reference

The fields above are the complete consumer-relevant shape. For the canonical persisted `case.json`
layout (including internal fields like `capture`/`verified`), see [`SKILL.md`](../SKILL.md#step-4--report-to-user),
or read `scripts/finalize_case.mjs` / `scripts/render_case.mjs` directly — they are the source of truth.
